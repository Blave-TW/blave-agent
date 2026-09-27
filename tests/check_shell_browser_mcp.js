// 本機 MCP server(shell/browser/mcp.js):真 HTTP 打。錯 token / 舊 token / 錯 Host / 帶 Origin 全拒;
// initialize → tools/list → tools/call 走得通;回合結束 token 作廢;在途呼叫看得到回合已結束。
// 跑法:node tests/check_shell_browser_mcp.js
const http = require("http");
const { createMcpServer } = require("../shell/browser/mcp");
const { TOOLS } = require("../shell/browser/tools");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };

function post(port, body, headers) {
  return new Promise((resolve) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: (headers && headers.__path) || "/mcp", method: (headers && headers.__method) || "POST",
      headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(data) }, headers || {}) }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch (_) { /* 空 */ } resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    req.on("error", () => resolve({ status: 0 }));
    for (const k of Object.keys(headers || {})) if (k.startsWith("__")) req.removeHeader(k);
    req.end(data);
  });
}

(async () => {
  const calls = []; let release = null;
  const srv = createMcpServer({ tools: TOOLS, version: "test", call: async (name, args, ctx) => {
    calls.push([name, args]);
    if (name === "browser_wait") { await new Promise((r) => (release = r)); return { content: [{ type: "text", text: JSON.stringify({ live: ctx.live() }) }], isError: false }; }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, name }) }], isError: false };
  } });
  const port = await srv.start();
  t("綁 127.0.0.1 的隨機 port", port > 0 && srv.url() === "http://127.0.0.1:" + port + "/mcp");
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
  const H = (tok, extra) => Object.assign({ Authorization: "Bearer " + tok, Host: "127.0.0.1:" + port }, extra || {});

  t("沒有回合(沒有 token)時一律 401", (await post(port, init, H("x"))).status === 401);
  const tok = srv.beginTurn(1);
  t("錯 token → 401", (await post(port, init, H(tok + "x"))).status === 401 && (await post(port, init, { Host: "127.0.0.1:" + port })).status === 401);
  t("Host 不是 127.0.0.1:<port>(DNS rebinding)→ 403", (await post(port, init, H(tok, { Host: "evil.example:" + port }))).status === 403 && (await post(port, init, H(tok, { Host: "localhost:" + port }))).status === 403);
  t("帶 Origin(網頁發的)→ 403", (await post(port, init, H(tok, { Origin: "https://evil.example" }))).status === 403 && (await post(port, init, H(tok, { Origin: "null" }))).status === 403);
  t("GET → 405、別的路徑 → 404", (await post(port, "", H(tok, { __method: "GET" }))).status === 405 && (await post(port, init, H(tok, { __path: "/x" }))).status === 404);
  t("body 超過上限 → 413", (await post(port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { x: "a".repeat(300 * 1024) } }), H(tok))).status === 413);
  const r = await post(port, init, H(tok));
  const sid = r.headers["mcp-session-id"];
  t("initialize → 回 protocolVersion、tools 能力、Mcp-Session-Id", r.status === 200 && r.body.result.protocolVersion === "2025-06-18" && r.body.result.capabilities.tools && /^[0-9a-f]{32}$/.test(sid) && r.body.result.serverInfo.name === "blave_browser");
  t("notifications/initialized → 202", (await post(port, { jsonrpc: "2.0", method: "notifications/initialized" }, H(tok, { "Mcp-Session-Id": sid }))).status === 202);
  const list = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, H(tok, { "Mcp-Session-Id": sid }));
  const names = list.body.result.tools.map((x) => x.name);
  t("tools/list = 介面凍結的 16 支,沒有 eval", names.length === 16 && names.includes("browser_read") && names.includes("browser_search") && !names.some((n) => /eval|script|js/i.test(n)));
  const c = await post(port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_tabs", arguments: {} } }, H(tok, { "Mcp-Session-Id": sid }));
  t("tools/call 轉給實作", c.body.result.isError === false && JSON.parse(c.body.result.content[0].text).name === "browser_tabs");
  t("不存在的工具 → JSON-RPC 錯誤、不呼叫實作", (await post(port, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_eval", arguments: {} } }, H(tok, { "Mcp-Session-Id": sid }))).body.error.code === -32602 && calls.length === 1);
  t("不認得的 session id → 404", (await post(port, { jsonrpc: "2.0", id: 5, method: "tools/list" }, H(tok, { "Mcp-Session-Id": "nope" }))).status === 404);
  // 在途呼叫:回合中途結束
  const pending = post(port, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "browser_wait", arguments: {} } }, H(tok, { "Mcp-Session-Id": sid }));
  await new Promise((r2) => setTimeout(r2, 100));
  srv.endTurn(); release();
  const p = await pending;
  t("回合結束時在途的呼叫看得到 live() = false(不會對已結束回合的分頁動手)", JSON.parse(p.body.result.content[0].text).live === false);
  t("回合結束後舊 token 作廢", (await post(port, init, H(tok))).status === 401);
  const tok2 = srv.beginTurn(2);
  t("新回合換一顆新 token", tok2 !== tok && (await post(port, init, H(tok2))).status === 200 && (await post(port, init, H(tok))).status === 401);
  srv.close();
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
