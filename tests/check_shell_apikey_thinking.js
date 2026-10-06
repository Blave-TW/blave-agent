// 轉送口的思考規則(shell/llmrelay.js thinkingPolicy;跟 api proxy 同一條判準):主回合一律開思考、幕後一律 flash 關思考。
const path = require("path"), http = require("http");
const { startRelay, thinkingPolicy, PRESETS } = require(path.join(__dirname, "..", "shell", "llmrelay.js"));

let fails = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fails++; };
const P = PRESETS.deepseek, TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];
const run = (body, purpose) => { const b = JSON.parse(JSON.stringify(body)); const bg = thinkingPolicy(P, b, purpose); return { b, bg }; };

let r = run({ model: "deepseek-v4-pro", tools: TOOLS, thinking: { type: "adaptive" }, output_config: { effort: "max" } });
t("主回合帶 adaptive + effort max:原樣(強度不動)", !r.bg && r.b.model === "deepseek-v4-pro" && r.b.thinking.type === "adaptive" && r.b.output_config.effort === "max");
r = run({ model: "deepseek-v4-flash", tools: TOOLS, thinking: { type: "adaptive" }, output_config: { effort: "low" } });
t("用戶選 flash 當主模型:是主回合(開思考、effort 不動)", !r.bg && r.b.model === "deepseek-v4-flash" && r.b.thinking.type === "adaptive" && r.b.output_config.effort === "low");
r = run({ model: "deepseek-v4-pro", tools: TOOLS, thinking: { type: "disabled" } });
t("請求自己帶 thinking disabled:當幕後(主回合實錄一律送 adaptive)→ flash、關思考", r.bg && r.b.model === "deepseek-v4-flash" && r.b.thinking.type === "disabled");
r = run({ model: "deepseek-v4-pro", tools: TOOLS });
t("主回合沒帶 thinking:補開", !r.bg && r.b.thinking.type === "adaptive");
r = run({ model: "deepseek/deepseek-background", tools: [], output_config: { effort: "high", format: { type: "json_schema" } } });
t("runtime 設的幕後 id deepseek/deepseek-background(標題請求):幕後 → flash、關思考", r.bg && r.b.model === "deepseek-v4-flash" && r.b.thinking.type === "disabled");
r = run({ model: "claude-haiku-9", tools: TOOLS, thinking: { type: "adaptive" } });
t("型錄外的 id(帶工具也一樣):幕後 → flash、關思考", r.bg && r.b.model === "deepseek-v4-flash" && r.b.thinking.type === "disabled");
r = run({ model: "deepseek-v4-pro", tools: TOOLS, thinking: { type: "adaptive" } }, "Background");
t("x-blave-purpose: background:幕後(大小寫不拘)", r.bg && r.b.thinking.type === "disabled");

// 經過轉送口:上游收到的就是改過的 body
(async () => {
  const log = [];
  const srv = http.createServer((req, res) => { const b = []; req.on("data", (c) => b.push(c)); req.on("end", () => {
    log.push(JSON.parse(Buffer.concat(b).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { output_tokens: 1 } }));
  }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const relay = await startRelay({ preset: "mock", key: "not-a-real-deepseek-key" }, { mock: { ...P, origin: `http://127.0.0.1:${srv.address().port}` } });
  const post = (body, extra) => new Promise((ok) => { const q = http.request({ hostname: "127.0.0.1", port: relay.port, path: "/v1/messages", method: "POST",
    headers: { "content-type": "application/json", "x-api-key": relay.token, ...(extra || {}) } }, (res) => { res.resume(); res.on("end", ok); }); q.end(JSON.stringify(body)); });
  await post({ model: "deepseek-v4-pro", max_tokens: 10, tools: TOOLS, messages: [] });
  await post({ model: "deepseek-v4-pro", max_tokens: 10, tools: TOOLS, messages: [] }, { "x-blave-purpose": "background" });
  t("經轉送口:主回合沒帶 thinking,到上游已補 adaptive", log[0] && log[0].thinking.type === "adaptive" && log[0].model === "deepseek-v4-pro");
  t("經轉送口:header 標幕後 → 上游收到 flash + disabled、stats.background 計 1", log[1] && log[1].model === "deepseek-v4-flash" && log[1].thinking.type === "disabled" && relay.stats.background === 1);
  relay.stop(); srv.close();
  console.log(fails ? `\n${fails} 項失敗` : "\n全部通過");
  process.exit(fails ? 1 : 0);
})();
