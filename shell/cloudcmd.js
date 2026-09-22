// Blave 電腦版 — 對雲端主機下指令的傳輸層(主行程用)。線 B 第二刀:`shell/cloud.js` 是讀,這個檔是寫。
// 契約:blave-canon output/backend/2026-09-21-desktop-cloud-write-contract.md
//
// 為什麼長這樣:
//   - 一次「用戶動作」一顆 `request_id`(在這裡鑄,不讓 renderer 給):api 靠它去重,同一顆在 15 分鐘內重送只會執行一次。
//     所以重試**必須沿用同一顆**——回傳值帶著 requestId,呼叫端重試時原樣傳回來(第四個參數)。自己換一顆 =
//     `close_all` 跑兩次、`amounts` 舊值蓋新值。
//   - 兩段:POST 指令拿到佇列 id,再去問 ack。**ack 桶是 120/分/帳號**,一次啟動就是兩個指令、各問 20 秒——
//     固定每秒問會撞桶,所以退避(500ms 起、×1.6、上限 3 秒、總窗 20 秒 ≈ 9–10 次)。第一次不在 t=0 問:
//     機器要先 BLPOP 取走才可能有回條。
//   - 逾時**不是失敗**:指令已經進佇列了,機器可能已經執行。走 `UNKNOWN_RESULT`(同本機宿主的語意),
//     畫面不可以說「沒送到」、不可以叫人重按。
//   - 相對的,409 `MACHINE_NOT_RUNNING` 是**真的沒送出**(api 不排隊、不記稽核)——不可沿用本機 daemon 沒跑時
//     `halt` 那個「已排隊」的說法。三桶對照見 KIND。
//   - **進了 ack 階段之後的任何失敗都是 `unknown`**,不是 `undelivered`:指令已經在佇列裡了。所以 ack 有自己的
//     interpretAck,指令階段的代號(429、5xx…)不會漏到 ack 階段。
//   - 這一份是誰的(比照 cloud.js / mcpcode.js):送出前那顆 token;換人 / 登出時世代 +1,在途的回應回來對不上就丟掉,
//     A 按的指令不會把結果畫到 B 的頁面上。同一個人的多個指令**可以並行**(啟動 = resume + restart_reconciler),
//     所以世代只在「換人 / 登出」時加,不是每次 send 都加。
//   - **POST 那一段照呼叫順序排隊,ack 等待照舊並行**(spec-desktop-start-pending-stop §1.1):api 是 RPUSH、機器 BLPOP,
//     按下順序 = 執行順序的前提是 POST 依序到 api。並行的話,啟動在路上時按的暫停可能先進佇列 → 最後停在下單中。
//     每一節由 postJSON 的 20 秒逾時兜底——那是 socket 閒置逾時、不是總時長:回應一直慢慢滴的話會拖住後面那一個(實務上很少見)。
//   - 憑證與金鑰的值只出現在 HTTPS body 裡:不回傳、不落地、不 log。這個檔不 require electron、不碰檔案系統。
//
// 給接線那一層(S2)的四條,不是實作細節,是契約:
//   1. **這裡不是 `secrets` 的信任邊界**:這個檔只看 `cmd === "credentials"`,任何呼叫端都塞得進 secrets。
//      閘門在 main.js 的 IPC——通用的 `cloud-send` 必須**拒收 secrets**,金鑰只由專用的 `cloud-connect` 供應。
//   2. 回傳**不是固定鍵集合**:`machineState` / `id` / `duplicate` / `requestId` 各有各的出現條件,一律當 optional 讀。
//   3. `undelivered` 這一桶敢說「沒送到」的前提是**重試沿用同一顆 `requestId`**(把回傳那顆原樣傳回第四個參數)。
//      不沿用的話,502 / 504 這種含糊情況會變成同一個動作執行兩次——這正是冪等在防的事。
//   4. `kind: "rejected"` 的 `error` 是用戶主機寫的字串、**長度無上限、不可信**:照 `trade.js:608` 截 200 字 + textContent。
const crypto = require("crypto");

const ENDPOINT = "/oauth/desktop/cloud/command";
const ACK_ENDPOINT = "/oauth/desktop/cloud/command/ack";
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;   // 契約 §2;佇列 id(sha256 前 32 碼)也落在這個形狀裡
const MACHINE_STATES = ["none", "starting", "stopped"];
const BAD_REQUEST_CODES = ["UNKNOWN_COMMAND", "REQUEST_ID_REQUIRED", "BAD_COMMAND"];
const ACK_FIRST_MS = 500, ACK_FACTOR = 1.6, ACK_MAX_MS = 3000, ACK_WINDOW_MS = 20 * 1000;

/* 錯誤代號 → 畫面的三桶(實作地圖 §7)。`rejected` 不在這張表裡:它只可能來自 ack 的 `ok:false`,
   那個字串是用戶主機寫的,不是代號。
   自己決定的兩個:`BAD_RESPONSE`(看得懂是壞回應的非 2xx:端點不見了 / 代理攔截 → 確定沒排進去)= undelivered;
   2xx 但拿不到佇列 id 的,結果跟逾時一樣不可知 → 直接走 `UNKNOWN_RESULT`,不另造第四種代號。 */
const KIND = {
  MACHINE_NOT_RUNNING: "undelivered", BAD_COMMAND: "undelivered", UNKNOWN_COMMAND: "undelivered",
  REQUEST_ID_REQUIRED: "undelivered", BODY_TOO_LARGE: "undelivered", AUDIT_UNAVAILABLE: "undelivered",
  RATE_LIMITED: "undelivered", OFFLINE: "undelivered", INVALID_CREDENTIALS: "undelivered",
  APP_SECRET_REQUIRED: "undelivered", BAD_RESPONSE: "undelivered", BAD_ARGS: "undelivered",
  NO_LOGIN: "undelivered",
  UNKNOWN_RESULT: "unknown",
  // `ACCOUNT_CHANGED` 刻意不在表裡:它的桶要看丟在哪一段(見 dropped()),查表會查到錯的那個
};

/* 指令那一段的回應 → { code, id?, duplicate?, machineState? }(純函式)。
   回傳裡不放 api 的 `error` 明細:那是給開發看的英文短句,畫面照代號給話。 */
function interpret(res) {
  if (!res || !res.status) return { code: "OFFLINE" };
  const s = res.status, b = res.body && typeof res.body === "object" ? res.body : {};
  if (s === 401) return { code: b.error_code === "APP_SECRET_REQUIRED" ? "APP_SECRET_REQUIRED" : "INVALID_CREDENTIALS" };
  // 409 = 主機沒在跑(這個 app 不送 update,api 那兩個 update 專用的 409 碰不到)
  if (s === 409) return { code: "MACHINE_NOT_RUNNING", machineState: MACHINE_STATES.indexOf(b.machine_state) >= 0 ? b.machine_state : null };
  if (s === 429) return { code: "RATE_LIMITED" };
  if (s === 413) return { code: "BODY_TOO_LARGE" };
  if (s === 400) return { code: BAD_REQUEST_CODES.indexOf(b.error_code) >= 0 ? b.error_code : "BAD_COMMAND" };
  if (s === 503 && b.error_code === "AUDIT_UNAVAILABLE") return { code: "AUDIT_UNAVAILABLE" };
  if (s >= 500) return { code: "OFFLINE" };
  if (s === 200 && b.status === "queued" && typeof b.id === "string" && REQUEST_ID_RE.test(b.id))
    return { code: "QUEUED", id: b.id, duplicate: b.duplicate === true };
  if (s >= 200 && s < 300) return { code: "UNKNOWN_RESULT" };   // 2xx 但看不懂:可能已經排進去了,不能說沒送到
  return { code: "BAD_RESPONSE" };
}

/* ack 的回應 → { state: "PENDING" | "DONE" | "STOP", ok?, result?, error? }(純函式)。
   指令已經在佇列裡了,所以除了「回條到了」以外一律再問一次:429 / 5xx / 連不上都只是這一次沒問到。
   401(憑證被撤)與 400(id 壞掉)再問幾次也不會變,提早停,結果照樣是不可知。 */
function interpretAck(res) {
  if (!res || !res.status) return { state: "PENDING" };
  if (res.status === 401 || res.status === 400) return { state: "STOP" };
  if (res.status !== 200) return { state: "PENDING" };
  const b = res.body && typeof res.body === "object" ? res.body : {};
  if (b.status !== "done") return { state: "PENDING" };
  return b.ok === true ? { state: "DONE", ok: true, result: b.result }
    : { state: "DONE", ok: false, error: String(b.error || "FAILED") };   // 用戶主機寫的字串,不可信:畫面只能 textContent
}

/* opts:{ apiBase, getCreds() → { token, appSecret } | null, post(url, body) → Promise<{status, body}>, now?, setTimer? } */
function createCloudCmd(opts) {
  const now = opts.now || (() => Date.now());
  // 只排一次性的等待,沒有要取消的 timer(在途的指令由世代作廢,不靠清 timer)
  const setT = opts.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  let owner = null, gen = 0, chain = Promise.resolve();

  const creds = () => { let c = null; try { c = opts.getCreds(); } catch (_) { /* Keychain 讀不到 */ } return c && c.token && c.appSecret ? c : null; };
  const sleep = (ms) => new Promise((r) => setT(r, ms));
  /* 這一趟還算不算數:世代沒被加過(沒人登出 / 換帳號),而且現在登入的仍是送出時那顆 token。
     **讀不到憑證不算換人**:`safeStorage` 暫時不可用、鑰匙圈被鎖都會讓 getCreds 回 null,把它當成登出的話,
     20 秒的 ack 窗裡每一輪都是一個「在途的全部平倉被作廢成結果不明」的窗口。登出由 `reset()` 負責
     (S2 必須把它接在登出路徑上,同 `if (_mcp) _mcp.reset();`),換帳號由下一次 send 的 token 比對負責。
     每一輪只叫一次:getCreds 是 safeStorage 解密 + 讀檔,不是免費的。 */
  const ours = (mine, token) => { if (mine !== gen) return false; const cur = creds(); return !cur || cur.token === token; };

  /* 送一個指令並等機器的回條。
       args    — 形狀見契約 §2(api 端 `_cloud_command_args` 再驗一次);沒有就給 {}
       secrets — **只有 cmd === "credentials" 會被放進 body 的頂層 `secrets`**;別的指令帶了一律丟掉
                 (api 對非 credentials 帶 secrets 是 400,而呼叫端傳錯不該讓金鑰白跑一趟網路)
       opts    — { requestId }:重試時把上一趟回傳的那顆原樣傳回來(冪等)
     回 { ok:true, result, requestId, id, duplicate } 或 { ok:false, error, kind, requestId, id?, machineState? }。永遠不拋。 */
  async function send(cmd, args, secrets, sendOpts) {
    const requestId = (sendOpts && sendOpts.requestId) || crypto.randomBytes(16).toString("hex");
    if (!REQUEST_ID_RE.test(requestId)) return { ok: false, error: "BAD_ARGS", kind: KIND.BAD_ARGS, requestId: null };
    const c = creds();
    if (!c) { if (owner !== null) { gen++; owner = null; } return { ok: false, error: "NO_LOGIN", kind: KIND.NO_LOGIN, requestId }; }
    if (owner !== null && owner !== c.token) gen++;   // 換了人:上一個人還在途的指令,回應回來時丟掉
    owner = c.token;
    const mine = gen, token = c.token;
    // 換人 / 登出時丟掉在途的那一份。桶要看丟在哪一段:還沒排進佇列 = 確定沒送出;已經排進去了 = 結果不明
    const dropped = (queued) => ({ ok: false, error: "ACCOUNT_CHANGED", kind: queued ? "unknown" : "undelivered", requestId });

    const body = { token, app_secret: c.appSecret, request_id: requestId, cmd,
      args: args && typeof args === "object" ? args : {} };
    if (cmd === "credentials" && secrets && typeof secrets === "object") body.secrets = secrets;
    // 排在前一個 POST 後面(檔頭)。排隊的時候登出 / 換人了 = 不打上線,確定沒送出
    const turn = chain.then(async () => {
      if (mine !== gen) return { skipped: true };
      let res = null;
      try { res = await opts.post(opts.apiBase + ENDPOINT, body); } catch (_) { /* 連不上 */ }
      return { res };
    });
    chain = turn.then(() => {}, () => {});
    const got = await turn;
    if (got.skipped) return dropped(false);
    const res = got.res;
    // 先看回應再判要不要丟(interpret 是純函式、不帶機密,重排安全)。排隊那一段的 await 已經由 skipped 處理(那時確定沒上線);
    // 走到這裡的一定是請求已經打上線的——api 已經回了 queued 卻說「沒送到」,用戶會去重按一次全部平倉
    const r = interpret(res);
    if (!ours(mine, token)) return dropped(r.code === "QUEUED" || r.code === "UNKNOWN_RESULT");
    if (r.code !== "QUEUED")
      return { ok: false, error: r.code, kind: KIND[r.code] || "undelivered", requestId, machineState: r.machineState || null };

    // 排進去了:從這裡開始,任何問不到都是「結果不明」,不是「沒送到」
    const id = r.id, duplicate = r.duplicate;
    const deadline = now() + ACK_WINDOW_MS;
    let wait = ACK_FIRST_MS;
    for (;;) {
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(wait, left));   // 最後一次縮短到剛好問滿 20 秒
      if (mine !== gen) return dropped(true);   // 便宜的那半(登出 / 換人已經發生過):不必讀憑證
      let ackRes = null;
      // 憑證用送出時讀到的那一份(它本來就在這個閉包的記憶體裡):一輪只讀一次,而且讀失敗不影響在途的這一顆
      try { ackRes = await opts.post(opts.apiBase + ACK_ENDPOINT, { token, app_secret: c.appSecret, id }); } catch (_) { /* 連不上:再問 */ }
      if (!ours(mine, token)) return dropped(true);   // 要回結果了才比對現在是誰
      const a = interpretAck(ackRes);
      if (a.state === "DONE")
        return a.ok ? { ok: true, result: a.result, requestId, id, duplicate }
          : { ok: false, error: a.error, kind: "rejected", requestId, id, duplicate };
      if (a.state === "STOP") break;
      wait = Math.min(Math.round(wait * ACK_FACTOR), ACK_MAX_MS);
    }
    return { ok: false, error: "UNKNOWN_RESULT", kind: KIND.UNKNOWN_RESULT, requestId, id, duplicate };
  }

  return {
    send,
    /* 登出:在途的指令回來時丟掉(它的結果是上一個人的)。**鏈不重設**:還沒出門的靠世代自己跳過;
       重設的話,登出再登入後按的暫停會插到還在路上的那個啟動 POST 前面。 */
    reset() { gen++; owner = null; },
  };
}

/* ── 不在 daemon.js UI_COMMANDS 裡的雲端指令:參數在這裡驗(main.js 的 cloud-send 用;本機那幾個走 daemon.argsOk)──
   delete_strategy = 只有 name,規則同機器端 `_cmd_delete_strategy` 與 api(資料夾名,不是顯示名稱)。
   `update` 不在這裡:用本機 app 不觸發雲端 agent 回合(Wei 09-22),api 那一支留給網頁。 */
const CLOUD_ONLY_COMMANDS = ["delete_strategy"];
const STRAT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
function cloudArgsOk(cmd, a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if (cmd === "delete_strategy") return keys.length === 1 && keys[0] === "name" && typeof a.name === "string" && STRAT_NAME_RE.test(a.name);
  return false;
}

/* ── 雲端連交易所(S5;main.js 的 cloud-connect 用)──────────────────────
   名字在主行程決定、renderer 給不了(renderer 被攻破也塞不進任意環境變數名)。模擬的三個不是祕密,契約仍要求走 secrets。
   回 { venue, secrets } 或 { error:"BAD_KEY_FORMAT" };shapeOk 由呼叫端注入(binance_link.keyShapeOk)。 */
function connectSecrets(a, shapeOk, nowSec) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { error: "BAD_ARGS" };
  if (a.venue === "paper") return { venue: "paper", secrets: { PAPER_API_KEY: "paper", PAPER_SECRET_KEY: "paper", PAPER_BOUND_TS: String(Math.floor(nowSec)) } };
  if (a.venue !== "binance") return { error: "BAD_ARGS" };
  const k = typeof a.apiKey === "string" ? a.apiKey.trim() : "", s = typeof a.secret === "string" ? a.secret.trim() : "";
  if (!k || !s || !shapeOk(k, s)) return { error: "BAD_KEY_FORMAT" };
  return { venue: "binance", secrets: { BINANCE_API_KEY: k, BINANCE_SECRET_KEY: s } };
}
/* 機器查權限的拒絕碼(runtime `_binance_bind_check`,與 binance_check.js 同一套)。**MVP 不查提領**(Wei 09-22):
   WITHDRAW_ENABLED 不在這張表上——萬一出現,照「其他拒絕」處理(原文截斷給人看)。 */
const CONNECT_CODES = ["TRADING_DISABLED", "INCOMPLETE_PAIR", "IP_OR_KEY", "BAD_KEY_FORMAT", "BAD_SECRET", "CLOCK", "RATE_LIMITED", "NETWORK", "UNKNOWN"];
/* cloudCmd.send("credentials") 的回傳 → { ok, code, detail }(純函式;detail 裡沒有金鑰——這個回傳本來就不含)。
     ok      → OK | NO_IP_RESTRICT(沒設白名單,不擋);detail = { spot, futures }。舊 runtime 回字串 "credentials=N" 也算 OK(Wei:這版不管)
     rejected→ 表上的代號;RATE_LIMITED 依說明字串再分 RATE_BANNED(418)/ RATE_BACKOFF(冷卻中、這次沒去問);其餘 REJECTED + 原文前 200 字
     其他    → UNDELIVERED / CMD_UNKNOWN,detail 帶 error / kind / machineState(畫面走 trSendError 那組雲端句) */
function interpretConnect(r, secrets) {
  if (r && r.ok) {
    const b = r.result && typeof r.result === "object" ? r.result.binance : null;
    if (b && typeof b === "object") return { ok: true, code: b.code === "NO_IP_RESTRICT" ? "NO_IP_RESTRICT" : "OK", detail: { spot: b.spot === false ? false : true, futures: b.futures === false ? false : true } };
    return { ok: true, code: "OK", detail: {} };
  }
  if (r && r.kind === "rejected") {
    const raw = String(r.error || ""), m = /^\s*ValueError:\s*([A-Z_]+):/.exec(raw), c = m ? m[1] : null;
    if (c && CONNECT_CODES.indexOf(c) >= 0) {
      if (c === "RATE_LIMITED") return { ok: false, code: /HTTPError 418/.test(raw) ? "RATE_BANNED" : /backing off/i.test(raw) ? "RATE_BACKOFF" : "RATE_LIMITED", detail: {} };
      return { ok: false, code: c, detail: {} };
    }
    // 原文是用戶主機寫的:今天的 runtime 不帶金鑰值,但這一句要畫到畫面上——用這一次送出的值再遮一次,不靠對方守規矩
    let shown = raw;
    Object.entries(secrets && typeof secrets === "object" ? secrets : {}).forEach(([k, v]) => { if (!/^PAPER_/.test(k) && typeof v === "string" && v.length >= 4) shown = shown.split(v).join("•••"); });
    // 再兜一層:16 字以上、**同時有字母和數字**的連續片段都遮(金鑰被改大小寫、截一段時上面比不到)。
    // 純字母的不遮:例外類名(BinanceAPIException)、英文長字照原樣,那是看得懂原因的關鍵
    shown = shown.replace(/[A-Za-z0-9]{16,}/g, (m) => (/[A-Za-z]/.test(m) && /[0-9]/.test(m) ? "•••" : m));
    return { ok: false, code: "REJECTED", detail: { error: shown.slice(0, 200) } };
  }
  const e = r && typeof r.error === "string" ? r.error : "OFFLINE";
  return { ok: false, code: r && r.kind === "unknown" ? "CMD_UNKNOWN" : "UNDELIVERED",
    detail: { error: e, kind: (r && r.kind) || "undelivered", machineState: (r && r.machineState) || null } };
}

module.exports = { createCloudCmd, interpret, interpretAck, KIND, CLOUD_ONLY_COMMANDS, cloudArgsOk, connectSecrets, interpretConnect, CONNECT_CODES, ENDPOINT, ACK_ENDPOINT, REQUEST_ID_RE, ACK_FIRST_MS, ACK_FACTOR, ACK_MAX_MS, ACK_WINDOW_MS };
