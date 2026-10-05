// 轉送口的每輪上限守得住(shell/llmrelay.js):並行、夾 max_tokens 預扣、中斷計費、排隊、413、扣住期間的 ping。
const path = require("path"), http = require("http");
const { startRelay, PRESETS } = require(path.join(__dirname, "..", "shell", "llmrelay.js"));

let fails = 0;
const t = (name, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fails++; };
const KEY = "not-a-real-deepseek-key";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* handler(body, res, n) 自己回;log 記每筆 body,peak 記同時在處理的最大筆數 */
function startMock(handler) {
  const log = []; let open = 0; const st = { peak: 0 };
  const srv = http.createServer((req, res) => {
    const bufs = []; req.on("data", (c) => bufs.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(bufs).toString("utf8"));
      log.push(body); open++; st.peak = Math.max(st.peak, open);
      res.on("close", () => { open--; });
      await handler(body, res, log.length);
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${srv.address().port}`, log, st, close: () => { srv.close(); srv.closeAllConnections(); } })));
}
const json = (res, out) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: out } })); };
const ev = (res, n, d) => res.write(`event: ${n}\ndata: ${JSON.stringify(d)}\n\n`);
const msgStart = (res) => ev(res, "message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
const thinking = (res) => { ev(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }); ev(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }); ev(res, "content_block_stop", { type: "content_block_stop", index: 0 }); };
const textEnd = (res, out) => {
  ev(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  ev(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } });
  ev(res, "content_block_stop", { type: "content_block_stop", index: 1 });
  ev(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: out } });
  ev(res, "message_stop", { type: "message_stop" }); res.end();
};

const relayFor = (mock, limits) => startRelay({ preset: "mock", key: KEY, limits: { minOutputTokens: 1, emptyBackoffMs: 5, ...limits } }, { mock: { ...PRESETS.deepseek, origin: mock.url } });
/* 回 { status, headers, body, headersAt(ms) };abortAfter = 收到幾 ms 後客戶端自己斷 */
const post = (relay, { maxTokens = 999999, stream = false, raw, abortAfter } = {}) => new Promise((resolve) => {
  const body = raw || JSON.stringify({ model: "deepseek-v4-pro", max_tokens: maxTokens, stream, messages: [{ role: "user", content: "x" }] });
  const t0 = Date.now();
  const r = http.request({ hostname: "127.0.0.1", port: relay.port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-api-key": relay.token } }, (res) => {
    const headersAt = Date.now() - t0, b = [];
    if (abortAfter != null) setTimeout(() => { r.destroy(); resolve({ status: res.statusCode, aborted: true }); }, abortAfter);
    res.on("data", (c) => b.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString("utf8"), headersAt }));
    res.on("error", () => {});
    res.on("close", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString("utf8"), headersAt, cut: true }));   // 被斷:end 不會來
  });
  r.on("error", () => resolve({ status: 0 }));
  r.end(body);
});
const settle = async (relay) => { for (let i = 0; i < 100 && (relay.stats.reserved || relay.stats.inflight); i++) await sleep(10); };

(async () => {
  // 並行:上游每筆都用滿它拿到的 max_tokens(最壞情況)
  {
    const mock = await startMock(async (b, res) => { await sleep(40); json(res, b.max_tokens); });
    const relay = await relayFor(mock, { maxOutputTokens: 1000, maxConcurrent: 3, maxQueued: 32 });
    const rs = await Promise.all(Array.from({ length: 20 }, () => post(relay)));
    await settle(relay);
    const sent = mock.log.reduce((a, b) => a + b.max_tokens, 0);
    t("並行 20 筆:上游同時最多 3 筆", mock.st.peak <= 3);
    t("並行 20 筆:送出去的 max_tokens 加總與實際用量都不超過每輪上限", sent <= 1000 && relay.stats.outputTokens <= 1000);
    t("並行 20 筆:額度用完之後的回 429 + x-should-retry: false(cap)", rs.some((r) => r.status === 429 && r.headers["x-should-retry"] === "false") && relay.stats.capHit);
    relay.stop(); mock.close();
  }
  // 同時在途上限(額度夠、只有並行數在擋)
  {
    const mock = await startMock(async (b, res) => { await sleep(40); json(res, 1); });
    const relay = await relayFor(mock, { maxConcurrent: 3, maxQueued: 32 });
    const rs = await Promise.all(Array.from({ length: 12 }, () => post(relay, { maxTokens: 10 })));
    t("額度夠時 12 筆並行:上游同時剛好 3 筆、其餘排隊後全部 200", mock.st.peak === 3 && rs.every((r) => r.status === 200) && mock.log.length === 12);
    relay.stop(); mock.close();
  }
  // 夾 max_tokens + 多退少補
  {
    const mock = await startMock(async (b, res) => json(res, 10));
    const relay = await relayFor(mock, { maxOutputTokens: 500 });
    const r = await post(relay, { maxTokens: 999999 });
    await settle(relay);
    t("max_tokens 999999 → 上游收到的夾到剩餘額度 500", r.status === 200 && mock.log[0].max_tokens === 500);
    t("結束照實際用量結算(預扣 500、用了 10 → 記 10、預扣歸零)", relay.stats.outputTokens === 10 && relay.stats.reserved === 0);
    const r2 = await post(relay, { maxTokens: 999999 });
    t("第二筆夾到 500 − 10 = 490", r2.status === 200 && mock.log[1].max_tokens === 490);
    relay.stop(); mock.close();
  }
  // 額度被在途的預扣佔著:排隊等退回,不是直接 cap
  {
    const mock = await startMock(async (b, res) => { await sleep(60); json(res, 10); });
    const relay = await relayFor(mock, { maxOutputTokens: 1000, minOutputTokens: 600 });
    const [a, b] = await Promise.all([post(relay, { maxTokens: 800 }), post(relay, { maxTokens: 800 })]);
    t("預扣佔滿時第二筆等第一筆退回再送(兩筆都 200、第二筆拿到 800)", a.status === 200 && b.status === 200 && mock.log[1] && mock.log[1].max_tokens === 800 && !relay.stats.capHit);
    relay.stop(); mock.close();
  }
  // 中斷計費
  {
    const mock = await startMock(async (b, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); msgStart(res); ev(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); ev(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }); await sleep(30); res.destroy(); });
    const relay = await relayFor(mock, { maxOutputTokens: 5000 });
    await post(relay, { maxTokens: 700, stream: true });
    await settle(relay);
    t("上游串流中途斷掉 → 照預扣值 700 計(不是 message_start 的 1)", relay.stats.outputTokens === 700 && relay.stats.reserved === 0);
    relay.stop(); mock.close();
  }
  {
    const mock = await startMock(async (b, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); msgStart(res); ev(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); ev(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }); await sleep(500); textEnd(res, 3); });
    const relay = await relayFor(mock, { maxOutputTokens: 5000 });
    await post(relay, { maxTokens: 300, stream: true, abortAfter: 50 });
    await settle(relay);
    t("引擎那端中途斷 → 照預扣值 300 計、在途歸零", relay.stats.outputTokens === 300 && relay.stats.reserved === 0 && relay.stats.inflight === 0);
    relay.stop(); mock.close();
  }
  // 排隊滿 / 等太久:429 但可重試(塞車不是上限)
  {
    const mock = await startMock(async (b, res) => { await sleep(150); json(res, 1); });
    const relay = await relayFor(mock, { maxConcurrent: 1, maxQueued: 1, maxQueueMs: 60 });
    const rs = await Promise.all([post(relay), post(relay), post(relay)]);
    const busy = rs.filter((r) => r.status === 429);
    t("排隊滿、等太久 → 429 + x-should-retry: true + retry-after,不記 cap", busy.length === 2 && busy.every((r) => r.headers["x-should-retry"] === "true" && r.headers["retry-after"]) && !relay.stats.capHit && mock.log.length === 1);
    relay.stop(); mock.close();
  }
  // 413
  {
    const mock = await startMock(async (b, res) => json(res, 1));
    const relay = await relayFor(mock, { maxBodyBytes: 1000 });
    const r = await post(relay, { raw: JSON.stringify({ model: "deepseek-v4-pro", max_tokens: 5, messages: [{ role: "user", content: "x".repeat(2000) }] }) });
    t("body 超過上限 → 413 + x-should-retry: false、不計筆數、不到上游", r.status === 413 && r.headers["x-should-retry"] === "false" && relay.stats.requests === 0 && mock.log.length === 0);
    t("預設單筆上限 16MB", require(path.join(__dirname, "..", "shell", "llmrelay.js")).DEFAULT_LIMITS.maxBodyBytes === 16 * 1024 * 1024);
    relay.stop(); mock.close();
  }
  // 扣住期間:header 立刻出去、ping 照時間送(上游沒資料、重送退避期間也送)
  {
    const mock = await startMock(async (b, res, n) => { res.writeHead(200, { "content-type": "text/event-stream" }); msgStart(res); thinking(res); await sleep(150); if (n === 1) { ev(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }); ev(res, "message_stop", { type: "message_stop" }); res.end(); } else textEnd(res, 2); });
    const relay = await relayFor(mock, { pingMs: 20, emptyBackoffMs: 100 });
    const r = await post(relay, { maxTokens: 100, stream: true });
    const pings = (r.body.match(/event: ping/g) || []).length;
    t("扣住、上游沒資料、重送退避期間都照時間送 ping(≥10 個)", pings >= 10 && mock.log.length === 2 && /"ok"/.test(r.body));
    relay.stop();
    const quiet = await relayFor(mock, { pingMs: 1e6, emptyRetries: 0 });   // 計時 ping 不會來:header 只能靠進扣住時那一下
    const q = await post(quiet, { maxTokens: 100, stream: true });
    t("扣住期間 header 立刻送出(不等上游收尾、不等第一個計時 ping)", q.status === 200 && q.headersAt < 100);
    quiet.stop(); mock.close();
  }
  console.log(fails ? `\n${fails} 項失敗` : "\n全部通過");
  process.exit(fails ? 1 : 0);
})();
