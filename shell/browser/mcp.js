// 本機 MCP server(三個引擎共用;不 require electron,tests/check_shell_browser_mcp.js 用真 HTTP 打)。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md §2.5。
//   - 綁 127.0.0.1:0(隨機 port);Bearer token **每回合一顆**,回合結束作廢(endTurn(id))。多條對話並行時同時有好幾顆(0.1.37),
//     每顆各自對到它那一輪;瀏覽器本身同時只給一輪用(opts.acquire 在開始計時之前先拿到租約,等租約的時間不算進 CALL_MAX_MS)。
//   - Host 必須是 127.0.0.1:<port>(擋 DNS rebinding 從分頁打回本機);帶 Origin 的一律拒(CLI 不帶,網頁會帶)。
//   - 手寫最小 streamable HTTP JSON-RPC(shell 沒有 @modelcontextprotocol/sdk,不新增 dependency):
//     initialize → notifications/initialized → tools/list → tools/call;GET/DELETE 回 405;回應一律 application/json 單次回覆。
//   - 這支 server 就是 agent 碰得到的全部能力:只暴露 tools.js 定義、已分級的動作。沒有 remote-debugging port。
"use strict";
const http = require("http");
const crypto = require("crypto");

const MAX_BODY = 256 * 1024;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// 一支工具最久這麼久要回(opts.maxMs(name) 可以給個別工具另外的數)。引擎那一端的逾時放得很寬(Claude 的設定檔 600 秒、
// Codex 600 秒,為了讓 browser_search 等得到用戶過驗證),卡死的工具由這裡收:到時間回一個講得出原因的結果,不讓引擎空等
const CALL_MAX_MS = 90000;

function createMcpServer(opts) {
  let port = 0, server = null;
  const tokens = new Map();     // token → turnId
  const sessions = new Map();   // Mcp-Session-Id → turnId(別一輪的 session 不認)
  // 回這顆 token 對到的 turnId;不認得回 undefined。逐顆比(同時只有幾顆),每顆都用定時比對
  const authTurn = (h) => {
    const a = Buffer.from(String(h || ""));
    let hit;
    for (const [tok, id] of tokens) { const b = Buffer.from("Bearer " + tok); if (a.length === b.length && crypto.timingSafeEqual(a, b)) hit = id; }
    return hit;
  };
  const turnLive = (id) => { for (const v of tokens.values()) if (v === id) return true; return false; };
  const send = (res, code, body, headers) => {
    const h = Object.assign({ "Cache-Control": "no-store" }, headers || {});
    if (body === undefined) { res.writeHead(code, h); return res.end(); }
    const s = JSON.stringify(body); h["Content-Type"] = "application/json";
    res.writeHead(code, h); res.end(s);
  };
  const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });

  async function handleRpc(msg, sid, res, turnId) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return send(res, 400, rpcErr(msg && msg.id, -32600, "invalid request"));
    const id = msg.id, isNote = id === undefined || id === null;
    if (msg.method === "initialize") {
      const want = msg.params && msg.params.protocolVersion;
      const newSid = crypto.randomBytes(16).toString("hex"); sessions.set(newSid, turnId);
      return send(res, 200, { jsonrpc: "2.0", id, result: {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "blave_browser", version: opts.version || "1" },
        instructions: opts.instructions || undefined,
      } }, { "Mcp-Session-Id": newSid });
    }
    if (isNote) return send(res, 202);   // notifications/initialized 之類:不回內容
    if (msg.method === "ping") return send(res, 200, { jsonrpc: "2.0", id, result: {} });
    if (msg.method === "tools/list") return send(res, 200, { jsonrpc: "2.0", id, result: { tools: opts.tools } });
    if (msg.method === "tools/call") {
      const p = msg.params || {};
      const tool = opts.tools.find((t) => t.name === p.name);
      if (!tool) return send(res, 200, rpcErr(id, -32602, "unknown tool"));
      const args = p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments) ? p.arguments : {};
      const myTurn = turnId;
      // connected():呼叫的那一端還在等這個回應。引擎自己逾時、回合被中斷時連線先斷,實作要看得到(不然它繼續等用戶、畫面停在「等你操作」)
      let gone = false, timer = null;
      res.on("close", () => { if (!res.writableEnded) gone = true; });
      // 瀏覽器只有一個:別一輪在用就在這裡等(回 null = 拿到了;回一個結果 = 等不到或這一輪已經結束,原樣交回)
      if (opts.acquire) {
        let deny = null;
        try { deny = await opts.acquire(myTurn, { connected: () => !gone, live: () => turnLive(myTurn) }); }
        catch (e) { deny = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "internal", message: String((e && e.message) || e).slice(0, 200) }) }], isError: true }; }
        if (deny) { if (res.destroyed) return undefined; return send(res, 200, { jsonrpc: "2.0", id, result: deny }); }
      }
      const cap = (opts.maxMs && opts.maxMs(tool.name)) || CALL_MAX_MS;
      const late = new Promise((resolve) => { timer = setTimeout(() => { gone = true; resolve({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: "timeout", message: "the built-in browser did not finish " + tool.name + " within " + Math.round(cap / 1000) + " s, so the call was ended. The page or the browser may be stuck: go on without this result or use another tab; do not repeat the same call right away" }) }], isError: true }); }, cap); });
      let result;
      try { result = await Promise.race([opts.call(tool.name, args, { turnId: myTurn, live: () => turnLive(myTurn), connected: () => !gone }), late]); }
      catch (e) { result = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "internal", message: String((e && e.message) || e).slice(0, 200) }) }], isError: true }; }
      finally { clearTimeout(timer); }
      if (res.destroyed) return undefined;
      return send(res, 200, { jsonrpc: "2.0", id, result });
    }
    return send(res, 200, rpcErr(id, -32601, "method not found"));
  }

  function onRequest(req, res) {
    if (req.headers.host !== "127.0.0.1:" + port) return send(res, 403);
    if (req.headers.origin !== undefined) return send(res, 403);
    const turnId = authTurn(req.headers.authorization);
    if (turnId === undefined) return send(res, 401);
    if (req.url !== "/mcp") return send(res, 404);
    if (req.method !== "POST") return send(res, 405, undefined, { Allow: "POST" });
    const sid = req.headers["mcp-session-id"];
    const bufs = []; let size = 0, dead = false;
    // 超過上限:回 413 並關掉這條連線(Connection: close),剩下的 body 丟掉不收——不直接 destroy socket,
    // 否則 keep-alive 的 client 會把下一個請求送進已經被重置的連線(Windows 實測)
    req.on("data", (c) => { if (dead) return; size += c.length; if (size > MAX_BODY) { dead = true; bufs.length = 0; send(res, 413, undefined, { Connection: "close" }); return; } bufs.push(c); });
    req.on("end", () => {
      if (dead) return;
      let msg; try { msg = JSON.parse(Buffer.concat(bufs).toString("utf8")); } catch (_) { return send(res, 400, rpcErr(null, -32700, "parse error")); }
      if (Array.isArray(msg)) return send(res, 400, rpcErr(null, -32600, "batching not supported"));
      if (msg.method !== "initialize" && sid !== undefined && sessions.get(String(sid)) !== turnId) return send(res, 404, rpcErr(msg.id, -32001, "session not found"));
      handleRpc(msg, sid, res, turnId).catch(() => { try { send(res, 500); } catch (_) { /* 已送出 */ } });
    });
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(onRequest);
        server.requestTimeout = 180000; server.headersTimeout = 10000;
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(port); });
      });
    },
    port: () => port,
    url: () => (port ? "http://127.0.0.1:" + port + "/mcp" : null),
    /** 新回合發一顆 token(別一輪的照舊有效);回合結束 endTurn(id) 只作廢那一輪的(在途的呼叫會看到 live() = false)。
        endTurn() 不帶 id = 全部作廢。 */
    beginTurn(id) { const tok = crypto.randomBytes(24).toString("hex"); tokens.set(tok, id); return tok; },
    endTurn(id) {
      for (const [tok, v] of tokens) if (id === undefined || v === id) tokens.delete(tok);
      for (const [sid, v] of sessions) if (id === undefined || v === id) sessions.delete(sid);
    },
    close() { if (server) server.close(); },
  };
}

module.exports = { createMcpServer, MAX_BODY, PROTOCOLS, CALL_MAX_MS };
