// 轉送口的空回應重試(shell/llmrelay.js):DeepSeek 思考模式偶爾整則只有 thinking 就收尾。
// 假上游依序回 replies[i];串流與非串流各跑一遍。
const path = require("path"), http = require("http");
const { startRelay, PRESETS } = require(path.join(__dirname, "..", "shell", "llmrelay.js"));

let fails = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fails++; };
const KEY = "not-a-real-deepseek-key";

const THINK = { type: "thinking", thinking: "hmm", signature: "sig" };
const TEXT = { type: "text", text: "ok" };
const TOOL = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } };

function sseBody(blocks, stop) {
  const out = [], ev = (n, d) => out.push(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
  ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === "thinking") {
      ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } });
    } else if (b.type === "text") {
      ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev("content_block_stop", { type: "content_block_stop", index: i });
  });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: stop || "end_turn" }, usage: { output_tokens: 5 } });
  ev("message_stop", { type: "message_stop" });
  return out.join("");
}

/* replies[i] = { blocks, stop } 或 { status };第 i 次請求回第 i 個(超出用最後一個) */
function startMock(replies) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const bufs = []; req.on("data", (c) => bufs.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(bufs).toString("utf8"));
      log.push(body);
      const r = replies[Math.min(log.length - 1, replies.length - 1)];
      if (r.status) { res.writeHead(r.status, { "content-type": "application/json" }); return res.end('{"type":"error","error":{"type":"overloaded_error","message":"x"}}'); }
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "m" + log.length, type: "message", role: "assistant", content: r.blocks, stop_reason: r.stop || "end_turn", usage: { input_tokens: 1, output_tokens: 5 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseBody(r.blocks, r.stop));
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${srv.address().port}`, log, close: () => { srv.close(); srv.closeAllConnections(); } })));
}

const post = (relay, stream) => new Promise((resolve) => {
  const body = JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 100, stream, messages: [{ role: "user", content: "x" }] });
  const u = new URL(relay.url + "/v1/messages");
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "x-api-key": relay.token } }, (res) => {
    const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(b).toString("utf8") }));
  });
  r.end(body);
});

async function run(replies, limits, stream) {
  const mock = await startMock(replies);
  const events = [];
  const relay = await startRelay({ preset: "mock", key: KEY, limits: { emptyBackoffMs: 5, ...limits }, onEvent: (e) => events.push(e) },
    { mock: { ...PRESETS.deepseek, origin: mock.url } });
  const r = await post(relay, stream);
  relay.stop(); mock.close();
  return { r, calls: mock.log.length, stats: relay.stats, events };
}

const textOf = (r, stream) => (stream ? r.body : JSON.stringify(JSON.parse(r.body).content));
const noPing = (s) => s.replace(/event: ping\ndata: \{"type": "ping"\}\n\n/g, "");

(async () => {
  for (const stream of [true, false]) {
    const m = stream ? "串流" : "非串流";
    let x = await run([{ blocks: [THINK] }, { blocks: [THINK, TEXT] }], {}, stream);
    t(`${m}:只有 thinking → 重送一次,第二次有內容交給引擎`, x.calls === 2 && x.r.status === 200 && /"ok"/.test(textOf(x.r, stream)) && x.stats.requests === 2 && x.stats.emptyRetries === 1);
    if (stream) t("串流:重送後交出的只有第二則(沒有第一則的 message_start 混進來)", (noPing(x.r.body).match(/event: message_start/g) || []).length === 1);

    x = await run([{ blocks: [] }], { emptyRetries: 2 }, stream);
    const last = stream ? sseBody([]) : null;
    t(`${m}:一直空 → 重送 2 次後原樣交出最後一則`, x.calls === 3 && x.r.status === 200 && (stream ? noPing(x.r.body) === last : JSON.parse(x.r.body).id === "m3") && x.events.some((e) => e.type === "empty_giveup"));

    x = await run([{ blocks: [THINK, TEXT] }], {}, stream);
    t(`${m}:thinking 之後有 text → 只打一次,thinking 原樣在`, x.calls === 1 && (stream ? noPing(x.r.body) === sseBody([THINK, TEXT]) : /"thinking":"hmm"/.test(x.r.body)));

    x = await run([{ blocks: [TOOL] }], {}, stream);
    t(`${m}:tool_use → 不重送`, x.calls === 1 && /toolu_1/.test(x.r.body));

    x = await run([{ blocks: [THINK] }], { maxRequests: 1 }, stream);
    t(`${m}:每輪筆數上限沒空間 → 不重送、原樣交出、記 cap`, x.calls === 1 && x.r.status === 200 && x.stats.capHit && x.events.some((e) => e.type === "cap"));

    x = await run([{ blocks: [THINK], stop: "max_tokens" }], {}, stream);
    t(`${m}:stop_reason=max_tokens 的空回應 → 不重送`, x.calls === 1);

    x = await run([{ blocks: [THINK] }, { status: 529 }], { emptyRetries: 1 }, stream);
    t(`${m}:重送回錯誤 → 交出前一則空回應(不是 529)`, x.calls === 2 && x.r.status === 200 && /hmm/.test(x.r.body));

    x = await run([{ blocks: [THINK] }, { blocks: [THINK] }, { blocks: [TEXT] }], { maxOutputTokens: 6, minOutputTokens: 1 }, stream);
    t(`${m}:重送的輸出 token 也算進上限(第二次之後超過就停)`, x.calls === 2 && x.stats.outputTokens >= 6 && x.stats.capHit);
  }
  console.log(fails ? `\n${fails} 項失敗` : "\n全部通過");
  process.exit(fails ? 1 : 0);
})();
