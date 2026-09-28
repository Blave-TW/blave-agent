// 本機 MCP server(三個引擎共用;不 require electron,tests/check_shell_browser_mcp.js 用真 HTTP 打)。
// 契約:.claude/output/specs/desktop-browser-agent-tools-2026-09-26.md §2.5。
//   - 綁 127.0.0.1:0(隨機 port);Bearer token **每回合一顆**,回合結束作廢(setToken(null))。
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
  let port = 0, token = null, turnId = null, server = null;
  const sessions = new Set();
  const authOk = (h) => {
    if (!token) return false;
    const a = Buffer.from(String(h || "")), b = Buffer.from("Bearer " + token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const send = (res, code, body, headers) => {
    const h = Object.assign({ "Cache-Control": "no-store" }, headers || {});
    if (body === undefined) { res.writeHead(code, h); return res.end(); }
    const s = JSON.stringify(body); h["Content-Type"] = "application/json";
    res.writeHead(code, h); res.end(s);
  };
  const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });

  async function handleRpc(msg, sid, res) {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return send(res, 400, rpcErr(msg && msg.id, -32600, "invalid request"));
    const id = msg.id, isNote = id === undefined || id === null;
    if (msg.method === "initialize") {
      const want = msg.params && msg.params.protocolVersion;
      const newSid = crypto.randomBytes(16).toString("hex"); sessions.add(newSid);
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
      let timer = null;
      const cap = (opts.maxMs && opts.maxMs(tool.name)) || CALL_MAX_MS;
      const late = new Promise((resolve) => { timer = setTimeout(() => { resolve({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: "timeout", message: "the built-in browser did not finish " + tool.name + " within " + Math.round(cap / 1000) + " s, so the call was ended. The page or the browser may be stuck: go on without this result or use another tab; do not repeat the same call right away" }) }], isError: true }); }, cap); });
      let result;
      try { result = await Promise.race([opts.call(tool.name, args, { turnId: myTurn, live: () => turnId === myTurn && !!token }), late]); }
      catch (e) { result = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "internal", message: String((e && e.message) || e).slice(0, 200) }) }], isError: true }; }
      finally { clearTimeout(timer); }
      return send(res, 200, { jsonrpc: "2.0", id, result });
    }
    return send(res, 200, rpcErr(id, -32601, "method not found"));
  }

  function onRequest(req, res) {
    if (req.headers.host !== "127.0.0.1:" + port) return send(res, 403);
    if (req.headers.origin !== undefined) return send(res, 403);
    if (!authOk(req.headers.authorization)) return send(res, 401);
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
      if (msg.method !== "initialize" && sid !== undefined && !sessions.has(String(sid))) return send(res, 404, rpcErr(msg.id, -32001, "session not found"));
      handleRpc(msg, sid, res).catch(() => { try { send(res, 500); } catch (_) { /* 已送出 */ } });
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
    /** 新回合換一顆 token;回合結束 setToken(null) 作廢(在途的呼叫會看到 live() = false)。 */
    beginTurn(id) { token = crypto.randomBytes(24).toString("hex"); turnId = id; sessions.clear(); return token; },
    endTurn() { token = null; turnId = null; sessions.clear(); },
    close() { if (server) server.close(); },
  };
}

module.exports = { createMcpServer, MAX_BODY, PROTOCOLS, CALL_MAX_MS };
