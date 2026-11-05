// 反方向的重播 fixture(tests/fixtures/relay_api_responses.json):api 回什麼 → 外殼怎麼反應。從 shell/relay.js 真正的路徑跑,
// 每個情境記下外殼依序送出的請求、api 這次回的回應、外殼叫了幾次 startTurn／stopTurn。api 那邊拿同一份核對「回這個,外殼就會那樣做」。
// 含聯合複稽核探針 A–D(停止時後面還有排隊、started 在路上時撤回、總開關關、started 回應遺失)與 api 用的「ack 之後、started 之前 sweep」。
//   跑法:node tests/check_shell_relay_api_responses.js           比對 fixture 與每個情境的斷言
//        node tests/check_shell_relay_api_responses.js --write   重產
//   api 那份:BLAVE_RELAY_API_DIR 或 ../api 底下的 tests/fixtures/relay_api_responses.json,找不到就 SKIP
const fs = require("fs"), os = require("os"), path = require("path");
const RL = require(path.join(__dirname, "..", "shell", "relay.js"));
const FIX = path.join(__dirname, "fixtures", "relay_api_responses.json");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const API = "https://api.test", S = "desktop-mresp0001", S2 = "desktop-mresp0002";
const name = (ep) => ep.split("/relay/")[1];
const okReport = (b) => ({ status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [], cancel: [] } });

/* script(ep, body, n) → 回應或 undefined(= 預設回應)。n = 這個端點第幾次被叫(從 0 起) */
function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-resp-"));
  const log = [], counts = {}, busy = new Set(o.busy || []), started = [], stopped = [];
  let pollWaiter = null;
  const post = async (url, body) => {
    const ep = url.slice(API.length), n = counts[ep] = (counts[ep] || 0);
    counts[ep]++;
    // 一律在回應回到外殼的那一刻記(實際發生的順序):掛著的 poll 是「回來」的時候才算數
    if (ep === RL.EP.poll) return new Promise((res) => { pollWaiter = (resp) => { log.push({ endpoint: name(ep), response: resp }); res(resp); }; });
    let resp = o.script ? o.script(ep, body, n) : undefined;
    if (resp && typeof resp.then === "function") resp = await resp;
    if (resp === undefined) {
      if (ep === RL.EP.enabled) resp = { status: 200, body: { enabled: true, on: true } };
      else if (ep === RL.EP.ack) resp = { status: 200, body: { acked: body.message_ids, rejected: [] } };
      else if (ep === RL.EP.report) resp = okReport(body);
      else if (ep === RL.EP.syncState) resp = { status: 200, body: { sessions: [], tombstones: [] } };
      else if (ep === RL.EP.enable) resp = { status: 200, body: { enabled: true, server_time: 1 } };   // 契約的形狀(mobile-pairing-v2-api §2)
      else if (ep === RL.EP.promptSeen) resp = { status: 200, body: { ok: true } };
      else resp = { status: 200, body: {} };
    }
    if (ep === RL.EP.ack || ep === RL.EP.report || ep === RL.EP.enable || ep === RL.EP.disable || ep === RL.EP.promptSeen || (ep === RL.EP.enabled && resp && (resp.status === 429 || (resp.body && ("prompt" in resp.body || "paired_notice" in resp.body || "paired_ever" in resp.body))))) {
      const { token, app_secret, device, ...rest } = body;   // eslint-disable-line no-unused-vars
      log.push({ endpoint: name(ep), body: rest, response: resp });
    }
    return resp;
  };
  const r = RL.createRelay({
    dir, stateDir: path.join(dir, "state"), apiBase: API, post, getCreds: () => ({ token: "t-resp", appSecret: "s-resp" }),
    installId: () => "11111111-2222-4333-8444-555555555555", ver: "0.1.37", claimDeadlineMs: 1200,
    startTurn: async (p) => { if (busy.has(p.sessionId)) return { busy: true }; busy.add(p.sessionId); started.push(p.message); return { started: true }; },
    stopTurn: (sid) => { stopped.push(sid); return true; }, turnBusy: (sid) => busy.has(sid), isRestarting: () => false,
    sessions: { list: () => [], rowsAfter: () => [], maxId: () => 0, exists: () => true, remove: () => true },
    turnArgs: () => ({}), known: () => [], origins: { add: () => {}, get: () => new Map() },
  });
  return { r, log, busy, started, stopped,
    poll: (status, body) => { const w = pollWaiter; pollWaiter = null; if (w) w({ status, body }); },
    feed: (messages, controls) => { const w = pollWaiter; pollWaiter = null; if (w) w({ status: 200, body: { enabled: true, messages: messages || [], controls: controls || [], server_time: 1 } }); },
    endTurn: (sid) => { busy.delete(sid); r.onTurn(sid, "turn-event", { type: "done", awaiting: false }); r.onTurn(sid, "turn-end", { code: 0, errTail: "" }); },
    end: async () => { await r.quit(); const w = pollWaiter; pollWaiter = null; if (w) w({ status: 0, body: null }); } };
}
const msg = (sid, id, content) => ({ message_id: id, session_id: sid, content, timestamp: 1, origin: "app", device_label: "iPhone 15" });
const settle = () => wait(RL.BATCH_MS + 80);
const sent = (m, type) => m.log.filter((x) => x.body && x.body.chunks).flatMap((x) => x.body.chunks).filter((c) => !type || c.type === type);

const CASES = [
  ["ack_rejected", "ack 回 rejected:那句不跑、不回 started", {
    script: (ep, b) => (ep === RL.EP.ack ? { status: 200, body: { acked: [], rejected: b.message_ids } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00001", "下單")]); await settle(); },
  (m) => m.started.length === 0 && !sent(m, "started").length],
  ["sweep_between_ack_and_started", "ack 之後、started 之前 api 已 sweep 判沒跑:started 回 cancel → 不跑、不回 start_aborted", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started")
      ? { status: 200, body: { results: [{ status: "cancel", message_id: b.chunks[0].message_id }], interrupt: [], cancel: [b.chunks[0].message_id] } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00002", "看一下")]); await settle(); },
  (m) => m.started.length === 0 && m.stopped.length === 0 && !sent(m, "start_aborted").length],
  ["report_interrupt", "跑中,report 回 interrupt:停那一條", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "text") ? { status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [S], cancel: [] } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00003", "掃參數")]); await wait(40); m.r.onTurn(S, "turn-event", { type: "text", text: "跑" }); await settle(); },
  (m) => m.stopped.join() === S],
  ["report_cancel_and_interrupt", "report 回 cancel(那句)＋interrupt(同一條):只停一次", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "text") ? { status: 200, body: { results: b.chunks.map(() => ({ status: "ok" })), interrupt: [S], cancel: ["msgresp00004"] } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00004", "跑")]); await wait(40); m.r.onTurn(S, "turn-event", { type: "text", text: "跑" }); await settle(); },
  (m) => m.stopped.length === 1],
  ["report_401", "跑中、後面排著,report 回 401:跑中的停、排隊的清掉", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "text") ? { status: 401, body: {} } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00005", "第一句")]); await wait(40); m.feed([msg(S, "msgresp00006", "第二句")]); await wait(40); m.r.onTurn(S, "turn-event", { type: "text", text: "x" }); await settle(); m.endTurn(S); await settle(); },
  (m) => m.stopped.includes(S) && m.started.length === 1 && m.r.state().queued === 0],
  ["poll_409", "poll 回 409 RELAY_NOT_ENABLED:補打 enable 再輪", {},
  async (m) => { m.poll(409, { error_code: "RELAY_NOT_ENABLED" }); await wait(60); },
  (m) => m.log.filter((x) => x.endpoint === "enable").length === 2],
  ["poll_403_with_controls", "poll 回 403 APP_CHAT_OFF 帶 controls:停止照做、relay 停、畫面藏起來", {},
  async (m) => { m.feed([msg(S, "msgresp00007", "第一句")]); await wait(40); m.poll(403, { error_code: "APP_CHAT_OFF", controls: [{ type: "interrupt", session_id: S }] }); await settle(); },
  (m) => m.stopped.includes(S) && m.r.state().visible === false && m.r.state().mobileTurns === 0],
  ["ack_lost", "ack 回應遺失:那句不跑、回 message_failed not_run", {
    script: (ep) => (ep === RL.EP.ack ? { status: 0, body: null } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00008", "下單")]); await settle(); },
  (m) => m.started.length === 0 && sent(m, "message_failed").some((c) => c.message_id === "msgresp00008" && c.code === "not_run")],
  ["ack_partial", "ack 回應只提到其中一句:沒提到的那句回 message_failed not_run", {
    script: (ep, b) => (ep === RL.EP.ack ? { status: 200, body: { acked: [b.message_ids[0]], rejected: [] } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00009", "a"), msg(S2, "msgresp00010", "b")]); await settle(); },
  (m) => m.started.length === 1 && sent(m, "message_failed").some((c) => c.message_id === "msgresp00010")],
  ["A_stop_with_queue", "探針 A:手機那輪在跑、同一條後面排著;手機按停止 → 停那輪、排著的回 cancelled,不會自己開跑", {},
  async (m) => { m.feed([msg(S, "msgresp00011", "第一句")]); await wait(40); m.feed([msg(S, "msgresp00012", "第二句:下單")]); await wait(40);
    m.feed([], [{ type: "interrupt", session_id: S }]); await wait(40); m.endTurn(S); await settle(); },
  (m) => m.started.join() === "第一句" && m.stopped.join() === S && sent(m, "cancelled").some((c) => c.message_ids.includes("msgresp00012"))],
  ["B_withdraw_during_started", "探針 B:排隊叫出、started 還在路上時撤回 → 不跑;start_aborted、cancelled、withdraw_result withdrawn", (() => {
    let release; const gate = new Promise((r) => { release = r; });
    return { busy: [S], gate: () => release(), script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") ? gate.then(() => okReport(b)) : undefined) };
  })(),
  async (m, o) => { m.feed([msg(S, "msgresp00013", "排隊那句")]); await wait(40); m.busy.delete(S); m.r.onTurn(S, "turn-end", { code: 0 }); await wait(40);
    m.feed([], [{ type: "withdraw", session_id: S, message_id: "msgresp00013" }]); await wait(40); o.gate(); await settle(); },
  (m) => m.started.length === 0 && m.stopped.length === 0 && ["start_aborted", "cancelled", "withdraw_result"].every((t) => sent(m, t).length) && sent(m, "withdraw_result")[0].result === "withdrawn"],
  ["B2_interrupt_during_started", "started 還在路上時手機按停止 → 不跑;start_aborted、cancelled,沒有 withdraw_result(沒人撤回)", (() => {
    let release; const gate = new Promise((r) => { release = r; });
    return { gate: () => release(), script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") ? gate.then(() => okReport(b)) : undefined) };
  })(),
  async (m, o) => { m.feed([msg(S, "msgresp00018", "掃參數")]); await wait(40); m.feed([], [{ type: "interrupt", session_id: S }]); await wait(40); o.gate(); await settle(); },
  (m) => m.started.length === 0 && m.stopped.length === 0 && sent(m, "start_aborted").length === 1 && sent(m, "cancelled").length === 1 && !sent(m, "withdraw_result").length],
  ["started_502_then_ok", "started 回 502(部署中)→ 重送,第二次 ok 才開跑", {
    script: (ep, b, n) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") && !rig.seen502 ? (rig.seen502 = true, { status: 502, body: null }) : undefined) },
  async (m) => { rig.seen502 = false; m.feed([msg(S, "msgresp00019", "看一下")]); await wait(900); },
  (m) => m.started.length === 1 && m.log.filter((x) => x.body && x.body.chunks && x.body.chunks[0].type === "started").length === 2],
  ["started_400", "started 回 400(api 拒收)→ 不跑、回 message_failed not_run", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") ? { status: 400, body: { error_code: "BAD_REQUEST" } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00020", "看一下")]); await settle(); },
  (m) => m.started.length === 0 && sent(m, "message_failed").some((c) => c.message_id === "msgresp00020" && c.code === "not_run") && !sent(m, "start_aborted").length],
  ["desktop_turn_during_claim", "稽核 P2-1:認領途中電腦前的人那輪的事件與 turn-end 都不轉給手機、不收掉認領中那筆;認領回來時那條在忙 → start_aborted", (() => {
    let release; const gate = new Promise((r) => { release = r; });
    return { gate: () => release(), script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") ? gate.then(() => okReport(b)) : undefined) };
  })(),
  async (m, o) => { m.feed([msg(S, "msgresp00021", "手機:下單")]); await wait(40);
    m.busy.add(S); m.r.onTurn(S, "turn-event", { type: "text", text: "電腦前那個人的回覆" }); m.r.onTurn(S, "turn-end", { code: 0 }); await wait(40);
    o.gate(); await settle(); },
  (m) => !sent(m, "text").length && m.started.length === 0 && sent(m, "start_aborted").length === 1],
  ["done_502_retry", "稽核 P2-2:done 遇 502 → 放回去重送,不丟", (() => {
    let k = 0;
    return { script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "done") && !k++ ? { status: 502, body: null } : undefined) };
  })(),
  async (m) => { m.feed([msg(S, "msgresp00022", "看一下")]); await wait(40); m.endTurn(S); await wait(2600); },
  (m) => m.log.filter((x) => x.body && x.body.chunks && x.body.chunks.some((c) => c.type === "done")).length === 2],
  ["switch_off_during_claim_retry", "稽核 P3-2:started 第一次回應掉了、重送時總開關關(403)→ 補 start_aborted", (() => {
    let k = 0;
    return { script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") ? (k++ === 0 ? { status: 0, body: null } : { status: 403, body: { error_code: "APP_CHAT_OFF" } }) : undefined) };
  })(),
  async (m) => { m.feed([msg(S, "msgresp00023", "下單")]); await wait(1200); },
  (m) => m.started.length === 0 && sent(m, "start_aborted").some((c) => c.message_id === "msgresp00023")],
  ["switch_off_first_started", "稽核第四輪 P3:第一次 started 就被總開關擋下(403)→ start_aborted＋message_failed not_run 都送(api 沒記到開跑,認 message_failed)", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") ? { status: 403, body: { error_code: "APP_CHAT_OFF" } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00024", "下單")]); await settle(); },
  (m) => m.started.length === 0 && sent(m, "start_aborted").some((c) => c.message_id === "msgresp00024")
    && sent(m, "message_failed").some((c) => c.message_id === "msgresp00024" && c.code === "not_run")],
  ["started_after_same_session_done", "稽核第四輪 P1:上一輪的 done 連兩次 502(認領前那次 flush 也送不到)、同一條排著的下一句被叫出 → 先把 done 送到,started 才送", (() => {
    let k = 0;
    return { script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "done") && k++ < 2 ? { status: 502, body: null } : undefined) };
  })(),
  async (m) => { m.feed([msg(S, "msgresp00025", "第一句")]); await wait(40); m.feed([msg(S, "msgresp00026", "第二句:下單")]); await wait(40);
    m.endTurn(S); await wait(1000); },
  (m) => {
    const at = (f) => m.log.findIndex((x) => x.body && x.body.chunks && f(x));
    const doneOk = at((x) => x.body.chunks.some((c) => c.type === "done") && x.response.status === 200);
    const st2 = at((x) => x.body.chunks.some((c) => c.type === "started" && c.message_id === "msgresp00026"));
    return m.started.join() === "第一句,第二句:下單" && doneOk >= 0 && st2 > doneOk;
  }],
  ["withdraw_running", "撤回已經開跑的那句:不停,withdraw_result running", {},
  async (m) => { m.feed([msg(S, "msgresp00014", "跑")]); await wait(40); m.feed([], [{ type: "withdraw", session_id: S, message_id: "msgresp00014" }]); await settle(); },
  (m) => m.stopped.length === 0 && sent(m, "withdraw_result").some((c) => c.result === "running")],
  ["C_kill_switch", "探針 C:總開關關(report 回 403 APP_CHAT_OFF)時跑中、後面排著 → 跑中的停、排著的回 message_failed not_run,那輪結束後不開下一句", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "text") ? { status: 403, body: { error_code: "APP_CHAT_OFF" } } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00015", "第一句")]); await wait(40); m.feed([msg(S, "msgresp00016", "第二句")]); await wait(40);
    m.r.onTurn(S, "turn-event", { type: "text", text: "x" }); await settle(); m.endTurn(S); await settle(); },
  (m) => m.started.join() === "第一句" && m.stopped.includes(S) && m.r.state().visible === false && m.r.state().mobileTurns === 0 && m.r.state().queued === 0],
  // 打開(mobile-pairing-v2-api §2):enable 不帶驗證碼欄位,200 就開;其他回應都是沒開成
  ["enable_ok", "打開:enable 只帶憑證,200 → 開、輪詢", {}, async () => {}, (m) => m.r.isOn() === true && m.first.ok === true && JSON.stringify(m.log.find((x) => x.endpoint === "enable").body) === "{}"],
  ["enable_rate_limited", "打開:429 ERR429 走 FAILED", { script: (ep) => (ep === RL.EP.enable ? { status: 429, body: { error_code: "ERR429" } } : undefined) },
  async () => {}, (m) => m.r.isOn() === false && m.first.code === "FAILED"],
  ["enable_audit_unavailable", "打開:稽核寫不進(503 AUDIT_UNAVAILABLE)走 FAILED", { script: (ep) => (ep === RL.EP.enable ? { status: 503, body: { error_code: "AUDIT_UNAVAILABLE" } } : undefined) },
  async () => {}, (m) => m.r.isOn() === false && m.first.code === "FAILED"],
  ["enable_state_unavailable", "打開:503 RELAY_STATE_UNAVAILABLE 走 FAILED", { script: (ep) => (ep === RL.EP.enable ? { status: 503, body: { error_code: "RELAY_STATE_UNAVAILABLE" } } : undefined) },
  async () => {}, (m) => m.r.isOn() === false && m.first.code === "FAILED"],
  ["enable_chat_off", "打開:403 APP_CHAT_OFF 收起設定區", { script: (ep) => (ep === RL.EP.enable ? { status: 403, body: { error_code: "APP_CHAT_OFF" } } : undefined) },
  async () => {}, (m) => m.r.isOn() === false && m.r.state().visible === false],
  ["reenable_ok", "本機開著、api 沒記著:自動重打 enable(不帶驗證碼欄位),200 照常", {
    script: (ep, b, n) => (ep === RL.EP.enabled && n === 1 ? { status: 200, body: { enabled: true, on: false } } : undefined) },
  async (m) => { await m.r.tick(); }, (m) => m.r.isOn() === true && m.log.filter((x) => x.endpoint === "enable").length === 2 && JSON.stringify(m.log.filter((x) => x.endpoint === "enable")[1].body) === "{}"],
  // 配對確認框(§4):prompt 在 /relay/enabled(開關關著也打);〔不用〕打 prompt/seen,〔打開〕走 enable
  ["prompt_off_no", "開關關著:enabled 帶 prompt → 畫面拿到 ask;框一出現打 prompt/seen(device_id),按〔不用〕再打一次帶 answer no;再給同一個不再出", {
    noOn: true, script: (ep) => (ep === RL.EP.enabled ? { status: 200, body: { enabled: true, on: false, prompt: { device_id: "devresp0001", label: "iPhone 15", platform: "ios", paired_at: 1730530000 } } } : undefined) },
  async (m) => { m.ask = m.r.state().ask; m.r.askShown(m.ask.id); await m.r.askNo(m.ask.id); await m.r.tick(); },
  (m) => { const seen = m.log.filter((x) => x.endpoint === "prompt/seen").map((x) => x.body); return !!m.ask && m.ask.label === "iPhone 15" && m.ask.at === 1730530000000 && m.r.isOn() === false && m.r.state().ask === null
    && JSON.stringify(seen) === '[{"device_id":"devresp0001"},{"device_id":"devresp0001","answer":"no"}]'; }],
  ["prompt_off_on", "開關關著:框一出現打 prompt/seen,按〔打開〕→ enable(api 由 enable 覆寫),不再帶 answer", {
    noOn: true, script: (ep, b, n) => (ep === RL.EP.enabled ? { status: 200, body: { enabled: true, on: false, prompt: { device_id: "devresp0001", label: "iPhone 15", platform: "ios", paired_at: 1730530000 } } } : undefined) },
  async (m) => { m.ask = m.r.state().ask; m.r.askShown(m.ask.id); await m.r.setOn(true); await wait(20); },
  (m) => !!m.ask && m.r.isOn() === true && m.r.state().ask === null && JSON.stringify(m.log.filter((x) => x.endpoint === "prompt/seen").map((x) => x.body)) === '[{"device_id":"devresp0001"}]' && m.log.filter((x) => x.endpoint === "enable").length === 1],
  ["enabled_429", "/relay/enabled 每台限流 429 ERR429:總開關、開關、確認框都照上一次,不收起設定區、不停輪詢", {
    noOn: true, script: (ep, b, n) => (ep === RL.EP.enabled ? (n === 0 ? { status: 200, body: { enabled: true, on: false, prompt: { device_id: "devresp0001", label: "iPhone 15", platform: "ios", paired_at: 1730530000 } } } : { status: 429, body: { error_code: "ERR429", message: "Too many requests" } }) : undefined) },
  async (m) => { m.ask = m.r.state().ask; await m.r.tick(); }, (m) => m.r.state().visible === true && !!m.r.state().ask && m.r.state().ask.id === m.ask.id],
  // 側欄提示格(spec sidebar-prompt-slot §7):paired_ever 只收布林,讀不到(舊 api、怪值、非 200)= undefined,畫面不畫手機那則
  ["paired_ever_false", "enabled 帶 paired_ever:false → state().pairedEver === false", {
    noOn: true, script: (ep) => (ep === RL.EP.enabled ? { status: 200, body: { enabled: true, on: false, paired_ever: false } } : undefined) },
  async () => {}, (m) => m.r.state().pairedEver === false],
  ["paired_ever_true", "enabled 帶 paired_ever:true(含全部撤銷)→ state().pairedEver === true", {
    noOn: true, script: (ep) => (ep === RL.EP.enabled ? { status: 200, body: { enabled: true, on: false, paired_ever: true } } : undefined) },
  async () => {}, (m) => m.r.state().pairedEver === true],
  ["paired_ever_bad", "paired_ever 不是布林 → undefined(讀不到)", {
    noOn: true, script: (ep) => (ep === RL.EP.enabled ? { status: 200, body: { enabled: true, on: false, paired_ever: "false" } } : undefined) },
  async () => {}, (m) => m.r.state().pairedEver === undefined],
  ["paired_ever_gone", "先讀到 false、下一輪 500 → 回到 undefined,不留舊值", {
    noOn: true, script: (ep, b, n) => (ep === RL.EP.enabled ? (n === 0 ? { status: 200, body: { enabled: true, on: false, paired_ever: false } } : { status: 500, body: {} }) : undefined) },
  async (m) => { await m.r.tick(); }, (m) => m.r.state().pairedEver === undefined],
  // 開關開著時剛配對的手機(account-session-revoke §3.3):paired_notice 在 /relay/enabled;一行提示出現打 prompt/seen(不帶 answer),關掉不打
  ["paired_notice_on", "開關開著:enabled 帶 paired_notice → 畫面拿到 notice;一出現打 prompt/seen(device_id),之後 api 不再給、那一行留到關掉;關掉不打 api", {
    script: (ep, b, n) => (ep === RL.EP.enabled ? { status: 200, body: { enabled: true, on: true, prompt: null, paired_notice: n === 1 ? { device_id: "devresp0002", label: "Pixel 9", platform: "android", paired_at: 1730530000, more: 1 } : null } } : undefined) },
  async (m) => { await m.r.tick(); m.notice = m.r.state().notice; if (!m.notice || !m.r.noticeShown) return; m.r.noticeShown(m.notice.id); await wait(10); await m.r.tick(); m.kept = !!m.r.state().notice; m.r.noticeClose(m.notice.id); },
  (m) => !!m.notice && m.notice.label === "Pixel 9" && m.notice.more === 1 && m.notice.at === 1730530000000 && m.kept && m.r.state().notice === null
    && JSON.stringify(m.log.filter((x) => x.endpoint === "prompt/seen").map((x) => x.body)) === '[{"device_id":"devresp0002"}]'],
  ["D_started_lost", "探針 D:started 一直沒回應 → 重送到期限 → start_aborted＋message_failed not_run(不知道 api 有沒有記到開跑,api 認其中一個),不跑", {
    script: (ep, b) => (ep === RL.EP.report && b.chunks.some((c) => c.type === "started") ? { status: 0, body: null } : undefined) },
  async (m) => { m.feed([msg(S, "msgresp00017", "下單")]); await wait(2200); },
  (m) => m.started.length === 0 && m.log.filter((x) => x.body && x.body.chunks && x.body.chunks[0].type === "started").length >= 2 && m.r.state().mobileTurns === 0
    && sent(m, "start_aborted").length === 1 && sent(m, "message_failed").some((c) => c.code === "not_run")],
];

(async () => {
  const out = { spec: "mobile-agent-chat-mvp §1.3", source: "blave-agent shell/relay.js via tests/check_shell_relay_api_responses.js",
    note: "api 回應 → 外殼反應。requests = 照回應回到外殼的先後(實際發生的順序)記的請求(token、app_secret、device 拿掉)與 api 那次的回應;poll 只記回應;shell = 外殼叫了哪些 startTurn(訊息)／stopTurn(對話)", cases: [] };
  const checks = [];
  for (const [nm, desc, o, run, check] of CASES) {
    const m = rig(o);
    await m.r.tick(); if (!o.noOn) { m.first = await m.r.setOn(true); await wait(20); }
    await run(m, o);
    checks.push([nm, desc, check(m), { started: m.started, stopped: m.stopped, sent: sent(m).map((c) => c.type) }]);
    await m.end();
    out.cases.push({ name: nm, desc, requests: m.log, shell: { startTurn: m.started, stopTurn: m.stopped } });
  }
  const text = JSON.stringify(out, null, 2) + "\n";
  if (process.argv.includes("--write")) { fs.writeFileSync(FIX, text); console.log("wrote " + FIX); }
  for (const [nm, desc, pass, d] of checks) ok(nm + ":" + desc, pass, d);
  if (!process.argv.includes("--write")) ok("fixture 等於 relay.js 現在跑出來的(不等就重產:--write)", fs.existsSync(FIX) && fs.readFileSync(FIX, "utf8") === text);
  ok("fixture 裡沒有憑證", !/t-resp|s-resp/.test(text));
  const apiCopy = path.join(process.env.BLAVE_RELAY_API_DIR || path.join(__dirname, "..", "..", "api"), "tests", "fixtures", "relay_api_responses.json");
  if (!fs.existsSync(apiCopy)) console.log("SKIP  api 那份逐字比對(設 BLAVE_RELAY_API_DIR 指到 api checkout)");
  else ok("與 api 那份逐字相同", fs.readFileSync(apiCopy).equals(fs.readFileSync(FIX)), apiCopy);
  console.log(red ? `\n${red} FAIL` : "\nall pass");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
