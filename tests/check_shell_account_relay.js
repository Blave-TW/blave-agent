// 帳號轉送口(shell/acctrelay.js;0.1.37 技術方案 chat-tabs-parallel-tech §1.3)。用真 HTTP 打一個假的上游。
//   1. 轉出去帶的是 Keychain「當下那顆」帳號 token;回合中途換 token,下一筆就帶新的
//   2. 轉送 token 作廢後回 401(x-should-retry: false);不認得的 token、帶 Origin、Host 不對一律拒
//   3. 只放行 /openclaw/proxy/ 與 /openclaw/agent/report/,`..`、編碼過的點與斜線不算
//   4. 串流原樣轉送(分段、content-type、狀態碼);客戶端送來的 x-api-key／authorization／cookie 不往上游送
//   5. 401／403 ACCOUNT_TOKEN_INVALID → recover 一次、換到新的就重送同一份內文;換不到或別的 403 原樣交回
//   6. 接線:runTurn 的環境裡沒有帳號 token(只有轉送 token),回合收尾作廢;runtime 認 BLAVE_PROXY_BASE 但只收 127.0.0.1
// 跑法:node tests/check_shell_account_relay.js
const http = require("http"), path = require("path"), fs = require("fs");
const SH = path.join(__dirname, "..", "shell");
const { createAccountRelay, TOKEN_PREFIX } = require(path.join(SH, "acctrelay.js"));
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || d === undefined ? "" : "  " + JSON.stringify(d).slice(0, 500))); if (!c) red++; };

const seen = [];
let upMode = "ok";
const up = http.createServer((req, res) => {
  const bufs = []; req.on("data", (c) => bufs.push(c));
  req.on("end", () => {
    seen.push({ path: req.url, method: req.method, key: req.headers["x-api-key"], auth: req.headers["authorization"], cookie: req.headers["cookie"], origin: req.headers["origin"], body: Buffer.concat(bufs).toString() });
    if (upMode === "invalid-once" && req.headers["x-api-key"] === "proxy-acct-OLD") { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ error_code: "ACCOUNT_TOKEN_INVALID" })); }
    if (upMode === "credit") { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ error_code: "INSUFFICIENT_CREDIT" })); }
    if (req.url.startsWith("/openclaw/proxy/v1/messages") && /stream/.test(seen[seen.length - 1].body)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: a\ndata: 1\n\n"); setTimeout(() => { res.write("event: b\ndata: 2\n\n"); res.end(); }, 30);
      return;
    }
    res.writeHead(201, { "content-type": "application/json", "x-up": "yes" }); res.end(JSON.stringify({ ok: true, path: req.url }));
  });
});

function call(port, p, o = {}) {
  return new Promise((resolve) => {
    const body = Buffer.from(o.body || "{}");
    const headers = { "content-type": "application/json", "content-length": body.length, ...(o.headers || {}) };
    if (o.token) headers["x-api-key"] = "proxy-" + o.token;
    const r = http.request({ host: "127.0.0.1", port, path: p, method: o.method || "POST", headers, setHost: o.host === undefined }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push({ t: Date.now(), s: c.toString() }));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.map((c) => c.s).join(""), chunks }));
    });
    if (o.host !== undefined) r.setHeader("host", o.host);
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    r.end(body);
  });
}

(async () => {
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  let acct = "acct-A", recovers = 0, recoverTo = null;
  const R = createAccountRelay({ apiBase: `http://127.0.0.1:${up.address().port}`, upstream: http, loadToken: () => acct,
    recover: async (rejected) => { recovers++; if (recoverTo && rejected === acct) { acct = recoverTo; return true; } return false; } });
  const port = await R.start();
  const m = R.issue("desktop-aaaa1111");
  ok("轉送 token 的前綴同帳號 token(lib/report.py 看到 acct- 不送平台驗證,電腦版本來就不送)、位址是 127.0.0.1", m.token.startsWith(TOKEN_PREFIX) && m.token.startsWith("acct-") && m.base === `http://127.0.0.1:${port}`);

  let r = await call(port, "/openclaw/proxy/v1/messages?beta=true", { token: m.token, body: '{"x":1}', headers: { authorization: "Bearer leak", cookie: "c=1" } });
  ok("轉出去帶當下那顆帳號 token(proxy- 前綴)、路徑與 query 原樣、內文原樣", r.status === 201 && seen[0].key === "proxy-acct-A" && seen[0].path === "/openclaw/proxy/v1/messages?beta=true" && seen[0].body === '{"x":1}', [r, seen[0]]);
  ok("客戶端的 authorization／cookie 不往上游送;上游的回應 header 原樣交回", seen[0].auth === undefined && seen[0].cookie === undefined && r.headers["x-up"] === "yes");
  acct = "acct-B";
  await call(port, "/openclaw/proxy/v1/messages", { token: m.token });
  ok("回合中途換了 token:下一筆就帶新的(輪替跟回合脫鉤)", seen[1].key === "proxy-acct-B");
  r = await call(port, "/openclaw/agent/report/abc/validate", { token: m.token });
  ok("報告驗證那條也放行", r.status === 201 && seen[2].path === "/openclaw/agent/report/abc/validate");
  r = await call(port, "/openclaw/proxy/v1/models", { method: "GET", token: m.token, body: "" });
  ok("型錄(GET)也放行", r.status === 201 && seen[3].method === "GET");

  const before = seen.length;
  const denied = [];
  for (const p of ["/oauth/desktop/rotate", "/openclaw/proxyx", "/openclaw/proxy/../../oauth/desktop/rotate", "/openclaw/proxy/%2e%2e/x", "/openclaw/proxy/a%2fb", "/openclaw/agent/command/poll", "/"]) {
    const x = await call(port, p, { token: m.token }); if (x.status !== 404) denied.push([p, x.status]);
  }
  ok("只放行兩組前綴;`..`、%2e、%2f 都擋(404、不往上游)", denied.length === 0 && seen.length === before, denied);
  r = await call(port, "/openclaw/proxy/v1/messages", { token: "acct-relay-nope" });
  ok("不認得的轉送 token → 401、x-should-retry: false、不往上游", r.status === 401 && r.headers["x-should-retry"] === "false" && seen.length === before);
  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token, headers: { origin: "https://evil.example" } });
  ok("帶 Origin(網頁發的)→ 403", r.status === 403 && seen.length === before);
  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token, host: "evil.example:80" });
  ok("Host 不是 127.0.0.1:<port>(DNS rebinding)→ 403", r.status === 403 && seen.length === before);
  r = await call(port, "/openclaw/proxy/v1/messages", { headers: { authorization: "Bearer " + m.token } });
  ok("Bearer 帶轉送 token 也認(跟 x-api-key 同一顆)", r.status === 201);

  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token, body: '{"stream":true}' });
  ok("串流原樣轉送:狀態碼、content-type、分段到達(不是等整份)", r.status === 200 && /event-stream/.test(r.headers["content-type"]) && r.body === "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n" && r.chunks.length >= 2 && r.chunks[r.chunks.length - 1].t - r.chunks[0].t >= 20, r);

  acct = "acct-OLD"; recoverTo = "acct-NEW"; upMode = "invalid-once"; const n0 = seen.length;
  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token, body: '{"q":7}' });
  ok("403 ACCOUNT_TOKEN_INVALID → recover 一次、換到新的就用同一份內文重送", r.status === 201 && recovers === 1 && seen.length === n0 + 2 && seen[n0 + 1].key === "proxy-acct-NEW" && seen[n0 + 1].body === '{"q":7}', [r.status, recovers, seen.slice(n0)]);
  upMode = "credit"; const rc = recovers;
  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token });
  ok("別的 403(額度不足)不補救、原樣交回內文", r.status === 403 && recovers === rc && /INSUFFICIENT_CREDIT/.test(r.body));
  upMode = "invalid-once"; acct = "acct-OLD"; recoverTo = null;
  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token });
  ok("補救換不到:原樣交回 403(不重送)", r.status === 403 && /ACCOUNT_TOKEN_INVALID/.test(r.body));
  upMode = "ok";
  acct = null;
  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token });
  ok("登出了(Keychain 沒有 token):401、不替任何人送", r.status === 401);
  acct = "acct-B";
  const m2 = R.issue("desktop-bbbb2222");
  R.revoke(m.token);
  r = await call(port, "/openclaw/proxy/v1/messages", { token: m.token });
  const r2 = await call(port, "/openclaw/proxy/v1/messages", { token: m2.token });
  ok("一輪作廢只作廢那一顆:A 回 401,並行的 B 照常", r.status === 401 && r2.status === 201 && R.active() === 1);

  // ── 接線 ──
  const main = fs.readFileSync(path.join(SH, "main.js"), "utf8");
  const rt = main.slice(main.indexOf("async function runTurn("), main.indexOf("function turnWin()"));
  ok("runTurn:Blave AI 的環境只拿轉送口這一輪的 token;任何地方都不把 loadToken() 放進回合環境", /const acct = plan\.proxyToken \? \(await acctRelay\(\)\.start\(\), acctRelay\(\)\.issue\(sessionId\)\) : null;/.test(rt) && !/loadToken\(\) : null/.test(rt) && /\.\.\.llmEnv\(acct, relay\),/.test(rt));
  ok("回合收尾(含起不來的那幾條)作廢轉送 token", /const turnDone = \(\) => \{[^\n]*acctDone\(\); \};/.test(rt) && /catch \(err\) \{ [^\n]*acctDone\(\); throw err; \}/.test(rt) && /const acctDone = \(\) => \{ if \(acct\) acctRelay\(\)\.revoke\(acct\.token\); \};/.test(rt));
  const llmEnv = new Function(main.slice(main.indexOf("function llmEnv("), main.indexOf("/* 帳號轉送口(acctrelay.js)")) + "\n return llmEnv;")();
  const env = llmEnv(m2, null);
  ok("子行程環境:找不到帳號 token、只有轉送 token 與本機位址", !Object.values(env).some((v) => v === "acct-B") && env.BLAVE_PROXY_TOKEN === m2.token && env.BLAVE_PROXY_BASE.startsWith("http://127.0.0.1:"));
  const pyAt = fs.readFileSync(path.join(SH, "..", "runtime", "agent_turn.py"), "utf8"), pySs = fs.readFileSync(path.join(SH, "..", "runtime", "session_store.py"), "utf8");
  ok("runtime 兩處 PROXY_BASE_URL 認 BLAVE_PROXY_BASE,只收 http://127.0.0.1: 開頭,其餘照舊打 api", [pyAt, pySs].every((s) => /PROXY_BASE_URL = \(os\.environ\.get\("BLAVE_PROXY_BASE", ""\)\n\s+if os\.environ\.get\("BLAVE_PROXY_BASE", ""\)\.startswith\("http:\/\/127\.0\.0\.1:"\)\n\s+else "https:\/\/api\.blave\.org\/openclaw\/proxy"\)/.test(s)));
  ok("打包:acctrelay.js 在 files", /"acctrelay\.js"/.test(fs.readFileSync(path.join(SH, "electron-builder.config.js"), "utf8")));

  R.stop(); up.close();
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
