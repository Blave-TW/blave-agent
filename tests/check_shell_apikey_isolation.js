// 自帶 API 金鑰的閘門 G1:agent 讀不到真金鑰(shell/llmrelay.js + runtime 的轉送分支 + 隨 SDK 的 CLI)。
//   ① 純 node:轉送口本身的規則(token、Host、路徑、上限、model 改寫、thinking、不讀 fs / env)。
//   ② 整輪(要 BLAVE_TEST_PYTHON 裝了 claude-agent-sdk):mock 供應商 ← 轉送口(持有 sentinel 金鑰)← CLI ← agent_turn.py --delivery local。
//      mock 第一個回應叫 agent 跑探針,探針用各種方式找金鑰;探針輸出就是模型看得到的東西。
//      三道對照:正向(mock 收到的認證 = sentinel,證明金鑰真的被用到)、負向(同一支探針在「金鑰進 env」時找得到,證明探針有效)、
//      完整(每一段標記都要回來,探針半路死掉不能算綠)。
//   ③ 轉送口自己回的 429 帶 x-should-retry: false 時,CLI 不重試、回合幾秒內結束。
// 不連外網、不用真金鑰、不開視窗。跑法:BLAVE_TEST_PYTHON=~/Blave/venv/bin/python node tests/check_shell_apikey_isolation.js
// 範圍:這支證明「行程邊界」(env、argv、檔案、ps、轉送口)。金鑰落地加密靠 safeStorage(Keychain / DPAPI),plain node 測不到;
// task_for_pid 那段測的是未簽章的 node,不是 hardened 的 Blave.app。Windows 的記憶體 / DPAPI 那一層本來就不成立,不在這支。
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http"), crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const { startRelay, PRESETS } = require(path.join(ROOT, "shell", "llmrelay.js"));
const src = fs.readFileSync(path.join(ROOT, "shell", "main.js"), "utf8");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) { console.log("FAIL  main.js 裡找不到 " + from); process.exit(1); } return src.slice(a, b); };
eval(cut("const WIN_ENV_DROP", "// ~/Blave 的官方檔案").replace(/^const /gm, "var "));
eval(cut("function llmEnv", "const MESSAGE_MAX_BYTES"));

const SENTINEL = "sk-BLAVETEST-" + crypto.randomBytes(12).toString("hex");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "apikey-g1-"));

/* mock 供應商:只認 sentinel(像真的供應商只認真金鑰)。script(body) 決定回什麼 */
function startMock(script) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const bufs = []; req.on("data", (c) => bufs.push(c));
    req.on("end", () => {
      let body = {}; try { body = JSON.parse(Buffer.concat(bufs).toString("utf8")); } catch (_) {}
      const auth = req.headers["x-api-key"] || req.headers["authorization"] || "";
      log.push({ method: req.method, path: req.url, auth, headers: req.headers, body, raw: Buffer.concat(bufs).toString("utf8") });
      if (auth !== SENTINEL) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'); }
      const blocks = script(body);
      if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: blocks, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 3 } })); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      blocks.forEach((b, i) => {
        if (b.type === "text") { ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }); ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } }); }
        else { ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }); }
        ev("content_block_stop", { type: "content_block_stop", index: i });
      });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" }, usage: { output_tokens: 42 } });
      ev("message_stop", { type: "message_stop" }); res.end();
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}`, log, close: () => { srv.close(); srv.closeAllConnections(); } })));
}
const mockPresets = (url) => ({ mock: { ...PRESETS.deepseek, origin: url } });
const lastIsToolResult = (b) => { const m = (b.messages || []).slice(-1)[0]; return !!m && Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"); };
const req = (url, { method = "POST", headers = {}, body = '{"model":"deepseek-v4-pro","max_tokens":5,"messages":[{"role":"user","content":"x"}]}', target } = {}) => new Promise((resolve) => {
  const u = new URL(url);
  const r = http.request({ host: u.hostname, port: u.port, method, path: target || u.pathname, headers: { "content-type": "application/json", ...headers } }, (res) => {
    const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString() }));
  });
  r.on("error", (e) => resolve({ status: 0, err: e.code })); r.end(method === "GET" ? undefined : body);
});

async function unit() {
  // ── 轉送口不讀 fs / env:金鑰送去哪只看寫死的表 ──
  const rs = fs.readFileSync(path.join(ROOT, "shell", "llmrelay.js"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  t("llmrelay.js 不 require fs、不讀 process.env(userData 與環境都是 agent 寫得到的)", !/require\(["']fs["']\)/.test(rs) && !/process\.env/.test(rs));
  t("內建表只有 https 的 origin", Object.values(PRESETS).every((p) => /^https:\/\//.test(p.origin)));
  t("未知 preset 起不來", await startRelay({ preset: "evil", key: "k".repeat(20) }).then(() => false, (e) => e.message === "UNKNOWN_PRESET"));
  t("presets 的原型鏈上的名字不算(toString / __proto__)", await startRelay({ preset: "toString", key: "k".repeat(20) }).then(() => false, () => true));

  const mock = await startMock(() => [{ type: "text", text: "ok" }]);
  const relay = await startRelay({ preset: "mock", key: SENTINEL, limits: { maxRequests: 3 } }, mockPresets(mock.url));
  const base = relay.url + "/v1/messages";
  const ok = await req(base, { headers: { authorization: "Bearer " + relay.token } });
  t("Bearer token → 200,mock 收到的 x-api-key = 真金鑰、沒有 authorization", ok.status === 200 && mock.log[0].auth === SENTINEL && !mock.log[0].headers.authorization);
  const ok2 = await req(base, { headers: { "x-api-key": relay.token } });
  t("x-api-key token 也收", ok2.status === 200);
  const bad = await req(base, { headers: { "x-api-key": relay.token.slice(0, -1) + (relay.token.endsWith("0") ? "1" : "0") } });
  t("token 錯 → 403 + x-should-retry: false", bad.status === 403 && bad.headers["x-should-retry"] === "false");
  const none = await req(base);
  t("沒帶 token → 403 + x-should-retry: false", none.status === 403 && none.headers["x-should-retry"] === "false");
  const models = await req(relay.url + "/v1/models", { method: "GET", headers: { "x-api-key": relay.token } });
  t("白名單外的路徑(GET /v1/models)→ 404", models.status === 404);
  const host = await req(base, { headers: { "x-api-key": relay.token, host: "evil.example" } });
  t("Host 不是 127.0.0.1:port(DNS rebinding)→ 400", host.status === 400);
  const abs = await req(base, { headers: { "x-api-key": relay.token }, target: "http://api.deepseek.com/v1/messages" });
  t("絕對 URL 當 request target → 400", abs.status === 400);
  t("被擋的請求一筆都沒到上游", mock.log.length === 2);
  t("主模型、沒帶 thinking:補開思考(思考規則,細節在 check_shell_apikey_thinking.js)", mock.log[0].body.model === "deepseek-v4-pro" && mock.log[0].body.thinking.type === "adaptive");
  await req(base, { headers: { "x-api-key": relay.token }, body: '{"model":"claude-haiku-9","max_tokens":5,"thinking":{"type":"adaptive"},"messages":[]}' });
  t("型錄外的 model 改寫成 flash、帶了 adaptive 也改成關思考", mock.log[2].body.model === "deepseek-v4-flash" && mock.log[2].body.thinking.type === "disabled" && relay.stats.rewrites >= 1);
  const cap = await req(base, { headers: { "x-api-key": relay.token } });
  t("每輪筆數上限到 → 429 + x-should-retry: false、不到上游、stats.capHit", cap.status === 429 && cap.headers["x-should-retry"] === "false" && mock.log.length === 3 && relay.stats.capHit);
  relay.stop();
  const after = await req(base, { headers: { "x-api-key": relay.token } });
  t("stop() 之後舊 token 連不上(port 關閉)", after.status === 0);
  relay.stop();
  t("stop() 叫兩次不拋", true);

  const relay2 = await startRelay({ preset: "mock", key: SENTINEL, limits: { maxOutputTokens: 3, minOutputTokens: 1 } }, mockPresets(mock.url));
  await req(relay2.url + "/v1/messages", { headers: { "x-api-key": relay2.token } });
  const cap2 = await req(relay2.url + "/v1/messages", { headers: { "x-api-key": relay2.token } });
  t("輸出 token 上限(從回應的 usage 加總)到 → 下一筆 429", relay2.stats.outputTokens === 3 && cap2.status === 429 && cap2.headers["x-should-retry"] === "false");
  relay2.stop(); mock.close();

  t("llmEnv:轉送模式只給位址與 token,沒有 BLAVE_PROXY_TOKEN", JSON.stringify(Object.keys(llmEnv("acct-x", { url: "u", token: "t" }))) === '["BLAVE_LLM_RELAY_URL","BLAVE_LLM_RELAY_TOKEN"]');
  t("llmEnv:Blave AI 行為不變;自己的 CLI 什麼都不帶", llmEnv("acct-x", null).BLAVE_PROXY_TOKEN === "acct-x" && Object.keys(llmEnv(null, null)).length === 0);
  t("runTurn 用 llmEnv 組 env、turnDone 收掉轉送口", /\.\.\.llmEnv\(acct, relay\),/.test(src) && /if \(relay\) relay\.stop\(\); \};/.test(src));
  const turnSrc = cut("async function runTurn", "\n}\n");
  t("runTurn 裡真金鑰只交給 startRelay(llmKey.key 只出現一次)", (turnSrc.match(/llmKey\.key/g) || []).length === 1 && /startRelay\(\{ preset: llmKey\.preset, key: llmKey\.key, onEvent: onRelay \}\)/.test(turnSrc));
}

const PROBE = String.raw`
STOP="$1"; RELAY_PID="$2"; PROVIDER="$3"; SCAN="$4"
echo "==P1 env=="; env
echo "==P2 printenv=="; printenv
echo "==P3 set=="; set
echo "==P4 ancestors=="
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  echo "-- pid $pid"; ps eww -o command= -p "$pid" 2>&1; ps -o args= -p "$pid" 2>&1
  [ "$pid" = "$STOP" ] && break
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
done
echo "==P5 files=="
grep -raoE 'sk-[A-Za-z0-9_-]{6,}' "$SCAN" "$HOME" 2>/dev/null | head -50
ls -la "$HOME" "$HOME/.claude" 2>&1 | head -40
cat "$HOME/.claude.json" 2>/dev/null | head -c 4000
echo "==P6 proc=="; cat /proc/*/environ 2>/dev/null | tr '\0' '\n' | grep -aE 'KEY|TOKEN' | head -20; echo "(no /proc on darwin)"
echo "==P7 task_for_pid=="
python3 -c "
import ctypes,sys
libc=ctypes.CDLL(None); task=ctypes.c_uint(0)
me=ctypes.c_uint.in_dll(libc,'mach_task_self_')
print('kr=%d' % libc.task_for_pid(me, int(sys.argv[1]), ctypes.byref(task)))
" "$RELAY_PID" 2>&1
echo "==P8 relay_with_env_token=="
curl -s -o /dev/null -w 'status=%{http_code}\n' -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H "authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'content-type: application/json' -d '{"model":"deepseek-v4-pro","max_tokens":5,"messages":[{"role":"user","content":"x"}]}'
echo "==P9 provider_direct_with_relay_token=="
curl -s -o /dev/null -w 'status=%{http_code}\n' -X POST "$PROVIDER/anthropic/v1/messages" -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H 'content-type: application/json' -d '{}'
echo "==P10 relay_rules=="
curl -s -o /dev/null -w 'models=%{http_code}\n' "$ANTHROPIC_BASE_URL/v1/models" -H "x-api-key: $ANTHROPIC_AUTH_TOKEN"
curl -s -o /dev/null -w 'host=%{http_code}\n' -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H 'host: evil.example' -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -d '{}'
curl -s -D - -o /dev/null -X POST "$ANTHROPIC_BASE_URL/v1/messages" -d '{}' | tr -d '\r' | grep -iE '^(HTTP|x-should-retry)' | tr '\n' ' '; echo
echo "==END=="
`;
const MARKS = ["P1 env", "P2 printenv", "P3 set", "P4 ancestors", "P5 files", "P6 proc", "P7 task_for_pid", "P8 relay_with_env_token", "P9 provider_direct_with_relay_token", "P10 relay_rules", "END"];
const section = (out, name) => { const a = out.indexOf(`==${name}==`); if (a < 0) return ""; const b = out.indexOf("\n==", a + 4); return out.slice(a, b < 0 ? undefined : b); };

function turnDirs(tag) {
  const base = path.join(TMP, tag), ws = path.join(base, "workspace"), home = path.join(base, "home");
  for (const d of [ws, home, path.join(base, "state")]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "AGENTS.md"), path.join(ws, "AGENTS.md"));
  return { base, ws, home };
}
function runAgentTurn(py, dirs, relay, timeoutMs) {
  // 跟 runTurn 同一套組法:手寫白名單 + llmEnv + childEnv;值換成暫存目錄
  const env = childEnv({
    PATH: path.dirname(py) + path.delimiter + "/usr/bin:/bin:/usr/sbin:/sbin", HOME: dirs.home, BLAVE_PYTHON: py,
    ...llmEnv(null, relay),
    USER: os.userInfo().username, LOGNAME: os.userInfo().username, TMPDIR: path.join(dirs.base, "state"),
    BLAVE_AGENT_BASE: dirs.base, BLAVE_AGENT_WORKSPACE: dirs.ws, BLAVE_AGENT_HOME: dirs.base,
    BLAVE_AGENT_STATE: path.join(dirs.base, "state"), BLAVE_AGENT_DB: path.join(dirs.base, "state", "session.db"),
    BLAVE_KLINE_SOURCE: "binance", BLAVE_DATA_ACCESS: "0", BLAVE_DATA_ACCESS_WHY: "signed_out", BLAVE_BROWSER: "off", LANG: "en_US.UTF-8",
  });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(py, [path.join(ROOT, "runtime", "agent_turn.py"), "--delivery", "local", "--model", "deepseek-v4-pro", "--message-stdin", "--", "desktop-g1test" + crypto.randomBytes(2).toString("hex")],
      { env, cwd: dirs.ws, windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0, pid: child.pid }); });
    child.stdin.end("run the check");
  });
}

async function e2e() {
  const py = process.env.BLAVE_TEST_PYTHON;
  if (!py || spawnSync(py, ["-c", "import claude_agent_sdk"]).status !== 0) {
    console.log("SKIP  整輪(BLAVE_TEST_PYTHON 沒設或沒裝 claude-agent-sdk)"); return;
  }
  if (process.platform !== "darwin") { console.log("SKIP  整輪探針寫的是 darwin 的 ps / task_for_pid;Windows 另寫(見 handback 清單)"); return; }
  const dirs = turnDirs("g1");
  const probeFile = path.join(TMP, "probe.sh"); fs.writeFileSync(probeFile, PROBE);
  let mockUrl = "";
  let probed = false;
  const mock = await startMock((b) => {
    if (b.tools && b.tools.length && !lastIsToolResult(b) && !probed) {
      probed = true;
      return [{ type: "tool_use", id: "toolu_probe", name: "Bash", input: { command: `sh ${probeFile} ${process.pid} ${process.pid} ${mockUrl} ${TMP}`, description: "probe", timeout: 120000 } }];
    }
    return [{ type: "text", text: "done" }];
  });
  mockUrl = mock.url;
  const relay = await startRelay({ preset: "mock", key: SENTINEL }, mockPresets(mock.url));
  const r = await runAgentTurn(py, dirs, relay, 180000);
  relay.stop();
  const toolResults = [];
  for (const e of mock.log) for (const m of e.body.messages || []) if (Array.isArray(m.content)) for (const c of m.content) if (c.type === "tool_result")
    toolResults.push(typeof c.content === "string" ? c.content : JSON.stringify(c.content));
  const probeOut = toolResults.join("\n");
  t(`整輪跑完(exit ${r.code}, ${r.ms}ms)`, r.code === 0);
  if (r.code !== 0) console.log(r.err.slice(-1500));
  const missing = MARKS.filter((m) => probeOut.indexOf(`==${m}==`) < 0);
  t("完整對照:探針每一段標記都回到模型手上" + (missing.length ? " 缺 " + missing.join(",") : ""), missing.length === 0);
  // 探針 P9 用 curl 直接打 mock;轉送口不轉 user-agent,所以帶 curl UA 的就不是經轉送口來的
  const relayed = mock.log.filter((e) => e.path.startsWith("/anthropic/") && !/curl/.test(e.headers["user-agent"] || ""));
  t(`正向對照:經轉送口的每一筆(${relayed.length})認證都是 sentinel`, relayed.length >= 2 && relayed.every((e) => e.auth === SENTINEL));
  t("G1:sentinel 不在任何 tool_result 裡(env / printenv / set / 祖先 ps eww / argv / 檔案 / ~/.claude)", probeOut.indexOf(SENTINEL) < 0 && probeOut.indexOf(SENTINEL.slice(13)) < 0);
  t("G1:整段對話(每一筆上行請求的 body)都沒有 sentinel", mock.log.every((e) => e.raw.indexOf(SENTINEL) < 0));
  t("探針 env 段看得到轉送 token(預期:這一輪內 agent 拿得到它)", section(probeOut, "P1 env").indexOf(relay.token) >= 0);
  t("CLI 用的是 Bearer(ANTHROPIC_AUTH_TOKEN),環境裡沒有 ANTHROPIC_API_KEY", !/\nANTHROPIC_API_KEY=/.test(section(probeOut, "P1 env")) && /\nANTHROPIC_AUTH_TOKEN=/.test(section(probeOut, "P1 env")));
  t("祖先 ps eww 有走到 runtime python(探針真的往上讀了)", section(probeOut, "P4 ancestors").indexOf("agent_turn.py") >= 0 && section(probeOut, "P4 ancestors").indexOf("BLAVE_LLM_RELAY_TOKEN=") >= 0);
  t("task_for_pid(轉送口所在行程)被拒", /kr=[1-9]/.test(section(probeOut, "P7 task_for_pid")));
  t("拿 env 的轉送 token 打轉送口:這一輪內 200(所以要有每輪上限)", /status=200/.test(section(probeOut, "P8 relay_with_env_token")));
  t("拿轉送 token 直接打供應商:401(在轉送口以外沒用)", /status=401/.test(section(probeOut, "P9 provider_direct_with_relay_token")));
  const p10 = section(probeOut, "P10 relay_rules");
  t("agent 改路徑 404、改 Host 400、不帶 token 403 + x-should-retry: false", /models=404/.test(p10) && /host=400/.test(p10) && /403/.test(p10) && /x-should-retry: false/i.test(p10));
  const after = await req(relay.url + "/v1/messages", { headers: { authorization: "Bearer " + relay.token } });
  t("回合結束後舊 token 連不上", after.status === 0);

  // 負向對照:同一支探針,金鑰放進 env(舊做法)。A:直接繼承;B:探針自己的 env 拔掉,只靠讀祖先的 ps eww。
  // B 的父行程用 python(跟 runtime / CLI 一樣是非系統執行檔):darwin 的 ps 讀不到 /bin/sh 這類系統執行檔的環境,拿 sh 當父行程這條會假紅
  const negEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: dirs.home, ANTHROPIC_API_KEY: SENTINEL };
  const probeArgs = [probeFile, String(process.pid), "1", "http://127.0.0.1:9", TMP];
  const negA = spawnSync("sh", probeArgs, { env: negEnv, encoding: "utf8", timeout: 60000 }).stdout || "";
  const negB = spawnSync(py, ["-c", "import os,subprocess,sys; e=dict(os.environ); e.pop('ANTHROPIC_API_KEY'); sys.stdout.write(subprocess.run(['sh']+sys.argv[1:], env=e, capture_output=True, text=True).stdout)", ...probeArgs],
    { env: negEnv, encoding: "utf8", timeout: 60000 }).stdout || "";
  t("負向對照 A:金鑰在 env → 探針 env 段找得到", section(negA, "P1 env").indexOf(SENTINEL) >= 0);
  t("負向對照 B:探針自己的 env 沒有、父行程有 → 祖先 ps eww 段找得到", section(negB, "P1 env").indexOf(SENTINEL) < 0 && section(negB, "P4 ancestors").indexOf(SENTINEL) >= 0);
  mock.close();

  // ③ 上限 429 + x-should-retry: false:CLI 不重試、回合很快結束(若 CLI 改成照狀態碼重試,這裡會拖到分鐘級)
  let n = 0;
  const mock3 = await startMock(() => (++n === 1 ? [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi", description: "x" } }] : [{ type: "text", text: "done" }]));
  const relay3 = await startRelay({ preset: "mock", key: SENTINEL, limits: { maxRequests: 1 } }, mockPresets(mock3.url));
  const r3 = await runAgentTurn(py, turnDirs("cap"), relay3, 240000);
  relay3.stop(); mock3.close();
  t(`上限 429:上游只收到 1 筆、回合 ${r3.ms}ms 內結束(< 60s,沒在重試)`, mock3.log.length === 1 && relay3.stats.capHit && r3.ms < 60000);
}

(async () => {
  try { await unit(); await e2e(); }
  catch (e) { console.log("FAIL  例外:" + (e && e.stack || e)); red++; }
  finally { fs.rmSync(TMP, { recursive: true, force: true }); }
  console.log(red ? `${red} FAIL` : "ALL PASS");
  process.exit(red ? 1 : 0);
})();
