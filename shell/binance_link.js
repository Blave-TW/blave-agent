// Blave 電腦版 — 連接 Binance 真錢帳戶的流程(主行程用)。權限怎麼判讀在 binance_check.js,這個檔只管「什麼時候查、查完做什麼」。
//
// 為什麼長這樣:
//   - **檢查在主行程做,不在 renderer**:renderer 會渲染 LLM 與雲端來的文字,它被攻破時不能繞過「提領開著的 key 不存」。
//     所以 renderer 走的 trade-send `credentials` 仍然只收模擬交易(daemon.js CRED_KEYS);Binance 的金鑰只有這個檔
//     在檢查通過之後、用 trusted 的那條路送進 daemon。
//   - 金鑰的去處只有一個:daemon 寫進 workspace 的 .env(跟雲端主機、lib/ 讀的是同一個地方)。這個檔**不另存一份**——
//     不寫 userData、不 log、不進任何子行程的 argv 或環境;重查時從 .env 讀回來用完就丟。
//     落地的只有「上一次有結論的結果+當時的對外 IP」(state 檔,不含金鑰)。
//   - 對外 IP 只認 IPv4:Binance 的白名單只收 IPv4;拿到 IPv6 就當成沒拿到,不把一個貼了也沒用的位址給用戶。
//     呼叫端打 my_ip 時也要強制走 IPv4(family: 4),否則雙棧網路會回 IPv6。
//   - 重查只通知、不自動停單、不移除金鑰(binance_check.recheckVerdict 的契約;Wei 拍板);要連續兩次都中才發(CONFIRM_MS 之後再打一次)。
//   - 權限:現貨交易或合約交易至少開一個就收(lib/order_binance 兩種都下得了);沒開的那個由畫面如實講。
//
// 這個檔不 require electron;HTTP、檔案、計時器、通知都由呼叫端注入(tests/check_shell_binance_link.js 用假的)。
const BC = require("./binance_check");

const CONFIRM_MS = 5 * 60 * 1000;          // 第一次中了之後隔多久再確認一次
const TIMER_SLACK_MS = 5000;               // 計時器早幾秒到不算沒隔滿
const BACKOFF_MS = { 429: 60 * 1000, 418: 5 * 60 * 1000 };   // 被限速後主鈕要鎖多久(spec §5.3)
const KEY_RE = /^[A-Za-z0-9]{16,128}$/;    // Binance 的 HMAC key / secret 是 64 碼英數;留一點餘裕,但不收空白、引號、換行
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ENV_NAMES = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"];

/* my_ip 的回應 → IPv4 字串或 null(純函式)。family 不是 4、或字串不是 IPv4,一律 null。 */
function pickIp(res) {
  const b = res && res.status === 200 && res.body && typeof res.body === "object" ? res.body : null;
  if (!b || b.family !== 4 || typeof b.ip !== "string" || !IPV4_RE.test(b.ip)) return null;
  return b.ip;
}

const keyShapeOk = (apiKey, secret) => typeof apiKey === "string" && typeof secret === "string" && KEY_RE.test(apiKey) && KEY_RE.test(secret);

/* workspace 的 .env 內容 → { apiKey, secret } 或 null(純函式)。只認這兩個名字;值帶引號就剝掉一層。 */
function readKeys(envText) {
  const got = {};
  for (const line of String(envText || "").split(/\r?\n/)) {
    const m = /^\s*(BINANCE_API_KEY|BINANCE_SECRET_KEY)\s*=\s*(.*?)\s*$/i.exec(line);
    if (m) got[m[1].toUpperCase()] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return got.BINANCE_API_KEY && got.BINANCE_SECRET_KEY ? { apiKey: got.BINANCE_API_KEY, secret: got.BINANCE_SECRET_KEY } : null;
}

/* 給畫面的結果:只有代號與不含金鑰的細節。 */
const pub = (r) => (r ? { ok: !!r.ok, code: String(r.code), detail: { ipRestrict: r.detail && r.detail.ipRestrict === true, spot: r.detail ? r.detail.spot !== false : true, futures: r.detail ? r.detail.futures !== false : true, status: r.detail && r.detail.status || null, warn: !!(r.detail && r.detail.warn) } } : null);

/* opts:{
     http(url, headers) → Promise<{status, body}>      打 Binance(binance_check.check 用)
     myIp() → Promise<{status, body}> | 丟例外           打自家 api 的 my_ip(呼叫端負責強制 IPv4 與帶 token)
     send(env) → Promise<{ok, error?}>                   把 env 經 trusted 的路交給 daemon 寫進 .env
     readEnv() → string | null                           讀 workspace 的 .env(重查用)
     loadState() → object | null, saveState(obj)         上一次有結論的結果+當時的 IP(不含金鑰)
     notify({ reason, level, ip }) → boolean                   發 P1 本機通知;**真的送出去才回 true**
     onChange?(state)                                    畫面要重畫
     now?, setTimer?, clearTimer? } */
function createBinanceLink(opts) {
  const now = opts.now || (() => Date.now());
  const setT = opts.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearT = opts.clearTimer || clearTimeout;
  let st = null, timer = null, busy = false, lockUntil = 0;
  // state:{ prev:{ok,code}, ipThen, last:{ok,code,detail}, verdict:{reason,ip}|null, pending:reason|null, checkedAt }
  const blank = () => ({ prev: null, ipThen: null, last: null, verdict: null, pending: null, pendingAt: 0, checkedAt: 0 });
  function load() { if (st) return st; let j = null; try { j = opts.loadState(); } catch (_) { /* 壞檔 = 沒有上一次 */ }
    st = blank();
    if (j && typeof j === "object") {
      if (j.prev && typeof j.prev.code === "string") st.prev = { ok: j.prev.ok === true, code: j.prev.code };
      if (typeof j.ipThen === "string" && IPV4_RE.test(j.ipThen)) st.ipThen = j.ipThen;
      if (j.last && typeof j.last.code === "string") st.last = pub(j.last);
      // 這個檔同一個用戶寫得到:reason 只認表上有的(稽核登記),級別照表、不照檔案寫的
      if (j.verdict && Object.prototype.hasOwnProperty.call(BC.VERDICT_LEVEL, j.verdict.reason)) st.verdict = { reason: j.verdict.reason, ip: typeof j.verdict.ip === "string" && IPV4_RE.test(j.verdict.ip) ? j.verdict.ip : null,
        level: BC.VERDICT_LEVEL[j.verdict.reason], code: typeof j.verdict.code === "string" ? j.verdict.code.slice(0, 40) : null, notified: j.verdict.notified === true };
      if (typeof j.checkedAt === "number") st.checkedAt = j.checkedAt;
    }
    return st; }
  function save() { try { opts.saveState({ prev: st.prev, ipThen: st.ipThen, last: st.last, verdict: st.verdict, checkedAt: st.checkedAt }); } catch (_) { /* 最壞 = 重開後少一次比對基準 */ }
    if (opts.onChange) try { opts.onChange(state()); } catch (_) { /* 畫面壞掉不影響重查 */ } }
  const state = () => { const s = load(); return { last: s.last, verdict: s.verdict, checkedAt: s.checkedAt, lockUntil }; };

  async function ip() { let res = null; try { res = await opts.myIp(); } catch (_) { /* 連不上 / 沒登入 */ } return pickIp(res); }

  /* 連接:先查權限,過了才交給 daemon 存。回 { ok, code, detail, lockMs? };ok:false 一律沒有儲存。 */
  async function connect(apiKey, secret) {
    if (busy) return { ok: false, code: "BUSY", detail: {} };
    if (now() < lockUntil) return { ok: false, code: "RATE_LIMITED", detail: {}, lockMs: lockUntil - now() };
    if (!keyShapeOk(apiKey, secret)) return { ok: false, code: "BAD_KEY_FORMAT", detail: {} };
    busy = true;
    try {
      const r = await BC.check({ apiKey, secret, market: "any", http: opts.http, now });
      if (!r.ok) {
        if (r.code === "RATE_LIMITED") { lockUntil = now() + (BACKOFF_MS[r.detail.status] || BACKOFF_MS[429]); return { ...pub(r), lockMs: lockUntil - now() }; }
        return pub(r);
      }
      const ipNow = await ip();
      const sent = await opts.send({ BINANCE_API_KEY: apiKey, BINANCE_SECRET_KEY: secret });
      if (!sent || !sent.ok) return { ok: false, code: "SEND_FAILED", detail: { error: String(sent && sent.error || "").slice(0, 200) } };
      load(); st.prev = { ok: true, code: r.code }; st.ipThen = ipNow; st.last = pub(r); st.verdict = null; st.pending = null; st.checkedAt = now(); save();
      schedule(BC.RECHECK_MS);
      return pub(r);
    } finally { busy = false; }
  }

  /* 重查一次(啟動時、每 24 小時、用戶按「重新測試」)。沒綁 Binance → 什麼都不做。
     manual = 用戶自己按的:他正看著畫面,結果直接上畫面、不等第二次確認,也不發系統通知。 */
  async function recheck(manual) {
    if (busy) return state();
    let keys = null; try { keys = readKeys(opts.readEnv()); } catch (_) { /* 讀不到 .env = 當成沒綁 */ }
    load();
    if (!keys) { if (st.prev || st.last || st.verdict) { st = blank(); save(); } schedule(BC.RECHECK_MS); return state(); }
    if (now() < lockUntil) { schedule(lockUntil - now()); return state(); }
    busy = true;
    try {
      const cur = await BC.recheck({ apiKey: keys.apiKey, secret: keys.secret, market: "any", http: opts.http, now });   // 存著的金鑰:不看提領那一格(MVP 不做那一則通知)
      keys = null;
      if (cur.code === "RATE_LIMITED") lockUntil = now() + (BACKOFF_MS[cur.detail.status] || BACKOFF_MS[429]);
      const ipNow = await ip();
      const v = BC.recheckVerdict(st.prev, cur, st.ipThen, ipNow);
      st.last = pub(cur); st.checkedAt = now();
      if (v) {
        // 兩次確認:第一次只記著、CONFIRM_MS 後再打;隔了夠久的第二次還是同一個 reason 才算數。中間好了(或變成沒結論)就當沒發生。
        // 已經確認過的同一件事(verdict 還在)不必再確認一輪。prev 不動:它是「上一次可以下單」的基準,要留到用戶修好為止
        const known = !!st.verdict && st.verdict.reason === v.reason;
        const confirmed = known || (st.pending === v.reason && now() - st.pendingAt >= CONFIRM_MS - TIMER_SLACK_MS);   // 真的隔滿 5 分鐘(Wei 拍板);啟動重查、解綁後重查在中途撞進來不算第二次
        if (manual || confirmed) {
          // code = 出事那一次 Binance 給的結論(畫面講原因用;st.last 會被之後的斷網蓋掉,所以另外記)
          // notified:**通知真的送出去**才算(稽核):字還沒交過來、系統不支援通知時 notify() 回 false,下一輪再試。
          // 用戶自己按的重新測試 = 他正看著畫面,算已經知道了
          const was = known && st.verdict.notified === true;
          st.pending = null; st.verdict = { reason: v.reason, level: v.level, ip: ipNow, code: cur.code, notified: was || manual };
          if (!st.verdict.notified) { let sent = false; try { sent = opts.notify({ reason: v.reason, level: v.level, ip: ipNow }) === true; } catch (_) { /* 沒送出去 */ } st.verdict.notified = sent; }
          save(); schedule(st.verdict.notified ? BC.RECHECK_MS : CONFIRM_MS); return state();
        }
        if (st.pending !== v.reason) { st.pending = v.reason; st.pendingAt = now(); }
        save(); schedule(CONFIRM_MS); return state();
      }
      st.pending = null;
      if (BC.INCONCLUSIVE.indexOf(cur.code) < 0) {           // 有結論
        if (cur.ok) { st.prev = { ok: true, code: cur.code }; st.verdict = null; if (ipNow) st.ipThen = ipNow; }
        else if (!st.prev || !st.prev.ok) st.prev = BC.nextPrev(st.prev, cur);
      }
      save(); schedule(cur.code === "RATE_LIMITED" ? lockUntil - now() : BC.RECHECK_MS);
      return state();
    } finally { busy = false; }
  }
  function schedule(ms) { if (timer) clearT(timer); timer = setT(() => { timer = null; recheck().catch(() => {}); }, Math.max(1000, ms)); }

  return {
    ip, connect, recheck: (manual) => recheck(manual === true), state,
    start() { recheck().catch(() => {}); },                     // 每次啟動查一次;之後自己排 24 小時
    stop() { if (timer) clearT(timer); timer = null; },
    // 電腦睡眠醒來:timer 在睡的時候不走。過期了才補查一次,不是每次醒來都打 Binance
    recheckIfDue() { load(); if (now() - st.checkedAt >= BC.RECHECK_MS) recheck().catch(() => {}); },
  };
}

module.exports = { createBinanceLink, pickIp, keyShapeOk, readKeys, ENV_NAMES, CONFIRM_MS, BACKOFF_MS };
