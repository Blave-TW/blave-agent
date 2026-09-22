// Blave 電腦版 — 連接 Binance 時的金鑰權限檢查(主行程用)。
//
// 依據:blave-canon output/research/binance-unrestricted-ip-key-expiry-2026-09.md(Binance 官方文件與公告)
//   - 2023-01-30 起,系統產生的一般 key(HMAC)沒設 IP 白名單就只能開讀取:交易權限開不了。
//     → 電腦版的做法(Wei 2026-09-21):收用戶習慣的一般 key,畫面列出目前的對外 IP 讓他設白名單(同雲端版)。
//   - 提領權限:MVP 不查、不擋、不提醒(Wei 2026-09-22 拍板);提領開著的 key 照存。
//   - 「交易權限 90 天到期」已於 2023-10-24 作廢;`tradingAuthorityExpirationTime` 已從官方文件消失,不依賴它。
//     可靠的訊號只有一個:定期重查,權限從 true 變 false 就是出事了。
//   - 家用 IP 會變:白名單裡的 IP 不是現在的 IP 時,Binance 回 -2015(跟金鑰無效同一個碼),所以要把
//     「IP 換了」當成 -2015 最可能的原因講給用戶聽,並給他新的 IP。
//
// 這個檔不 require electron;HTTP 由呼叫端注入(測試用假的)。金鑰只在記憶體裡經過,這裡不寫檔、不 log。
const crypto = require("crypto");

const SPOT = "https://api.binance.com";
const RECHECK_MS = 24 * 3600 * 1000;

const sign = (secret, query) => crypto.createHmac("sha256", secret).update(query).digest("hex");

/* 分類(純函式)。input:{ status, body }(apiRestrictions 的 HTTP 回應)、market:"futures" | "spot" | "any"(現貨或合約至少開一個)
   回 { ok, code, detail }:
     ok=true  code="OK"
     ok=false code=
       "TRADING_DISABLED"   交易權限沒開(最常見:沒設 IP 白名單所以開不了)
       "FUTURES_DISABLED"   要做合約但 Futures 沒開(key 建在開通合約帳戶之前就開不了,只能重建)
       "NO_IP_RESTRICT"     交易權限開著但沒有白名單(用戶自己關了預設安全管控):放行,但 detail.warn=true 提醒
       "IP_OR_KEY"          -2015:IP 不在白名單、金鑰無效、或權限不足——三者同一個碼
       "BAD_KEY_FORMAT"     -2014
       "BAD_SECRET"         -1022:簽章不對 = secret 貼錯
       "CLOCK"              -1021:電腦時間差太多
       "RATE_LIMITED"       HTTP 429 / 418:被 Binance 限速或暫時封 IP。呼叫端的重試**必須退讓**——429 不退讓會升級成 418 封 IP,
                            同一個 IP 上用戶的策略下單也會一起被封
       ("SKIPPED_TESTNET" 已拿掉,稽核 S3:呼叫端給得了的旗標就是檢查的開關。這裡一律查正式站;
        testnet 的 key 查正式站會被拒絕,而 lib/account_binance 本來就只連正式站——存一把用不了的 key 沒有意義。
        INCONCLUSIVE / recheckVerdict 裡留著這個代號只為了讀得懂舊的 state 檔。)
       "NETWORK" / "UNKNOWN"   UNKNOWN 含「HTTP 200 但回來的不是權限物件」:必要欄位不是 boolean 一律不下結論 */
function classify(res, market) {
  const b = res && res.body && typeof res.body === "object" ? res.body : {};
  if (!res || !res.status) return { ok: false, code: "NETWORK", detail: {} };
  if (res.status === 429 || res.status === 418) return { ok: false, code: "RATE_LIMITED", detail: { status: res.status } };
  if (res.status !== 200) {
    const c = Number(b.code);
    const code = c === -2015 ? "IP_OR_KEY" : c === -2014 ? "BAD_KEY_FORMAT" : c === -1022 ? "BAD_SECRET" : c === -1021 ? "CLOCK" : "UNKNOWN";
    return { ok: false, code, detail: { binance: Number.isFinite(c) ? c : null, status: res.status } };
  }
  // 200 但不是權限物件(HTML、沒 parse 的字串、{}、欄位型別不對):不下結論(稽核 B2-1、B2-2)。
  // 提領那一格已不擋(Wei 2026-09-22),但仍要求是 boolean——要不要一起拿掉待 Wei 決定
  for (const k of ["enableWithdrawals", "enableSpotAndMarginTrading", "enableFutures", "ipRestrict"]) if (typeof b[k] !== "boolean") return { ok: false, code: "UNKNOWN", detail: { status: 200, missing: k } };
  const detail = { ipRestrict: b.ipRestrict, createTime: Number(b.createTime) || null };
  const spotOn = b.enableSpotAndMarginTrading, futOn = b.enableFutures;
  detail.spot = spotOn; detail.futures = futOn;
  // "any"(連接畫面用):lib/order_binance 現貨(MARKET="spot")與合約都下得了,帳戶讀取不需要交易權限(實測)——
  // 所以至少開一個就收;沒開的那一個由畫面如實講(灰字),對應市場的策略下單會被 Binance 拒絕
  if (market === "any") { if (!spotOn && !futOn) return { ok: false, code: "TRADING_DISABLED", detail }; }
  else if (market === "spot" ? !spotOn : !futOn) {
    // 要做合約、現貨交易卻是開的 = 白名單沒問題,單純是 Futures 那一格沒開(多半是 key 建在開通合約帳戶之前)
    return { ok: false, code: market !== "spot" && spotOn ? "FUTURES_DISABLED" : "TRADING_DISABLED", detail };
  }
  if (!detail.ipRestrict) return { ok: true, code: "NO_IP_RESTRICT", detail: { ...detail, warn: true } };
  return { ok: true, code: "OK", detail };
}

/* 查一次(連接與重查共用)。http(url, headers) → Promise<{status, body}>;secret 只用來簽章。market 只認 "spot" / "futures" / "any"。 */
async function check({ apiKey, secret, market, http, now }) {
  if (market !== undefined && market !== "spot" && market !== "futures" && market !== "any") throw new Error("market must be \"spot\", \"futures\" or \"any\"");
  if (typeof apiKey !== "string" || typeof secret !== "string" || !apiKey || !secret) return { ok: false, code: "BAD_KEY_FORMAT", detail: {} };
  const q = `timestamp=${(now || Date.now)()}&recvWindow=10000`;
  let res = null;
  try { res = await http(`${SPOT}/sapi/v1/account/apiRestrictions?${q}&signature=${sign(secret, q)}`, { "X-MBX-APIKEY": apiKey }); } catch (_) { /* 連不上 */ }
  return classify(res, market || "futures");
}
const recheck = check;

/* 沒有結論的結果:不叫人、也不准蓋掉上一次的結論。 */
const INCONCLUSIVE = ["NETWORK", "CLOCK", "UNKNOWN", "RATE_LIMITED", "SKIPPED_TESTNET"];
/* prev 的語意寫死(稽核 B2-3):prev = 上一次**有結論**的結果。桌機隔天斷網是常態——OK → NETWORK → -2015 這個序列,
   如果呼叫端把 NETWORK 存成 prev,第三步就不會叫人、金鑰被刪沒人知道。呼叫端一律用 nextPrev() 更新 prev。 */
const nextPrev = (prev, cur) => (cur && INCONCLUSIVE.indexOf(cur.code) < 0 ? cur : prev);

/* 重查出事的歸級(canon notifications.md 的級別;要改只改這裡)。全部是「下單送不出去」:真的有單被拒時既有的 P1
   (下單失敗 → HALT)會接手,這裡只是提早講——所以都是 P2(只發系統通知、不亮 Dock 紅點)。
   MVP 不查提領(Wei 拍板),所以沒有「提領後來被打開」這一則。 */
const VERDICT_LEVEL = { TRADING_LOST: "P2", IP_CHANGED: "P2", KEY_REJECTED: "P2", REJECTED: "P2" };

/* 定期重查的判讀(純函式):上一次有結論的結果 → 這一次的結果,要不要叫人。
   回 null(沒事)或 { level, reason, confirm: true }:
     "TRADING_LOST"     原本可以,現在交易權限沒了
     "IP_CHANGED"       原本可以,現在 -2015,而且對外 IP 確定跟上次連上時不一樣(家用 IP 換了)
     "KEY_REJECTED"     原本可以,現在 -2015 而且兩次的對外 IP 都拿得到、確定沒變(金鑰被刪——含「沒白名單又閒置 30 天」——或權限被改);
                        或 -1022 / -2014:存著的金鑰本身對不上了(.env 被改壞)。這不是權限變了,不可以說成權限
     "REJECTED"         原本可以,現在 -2015,但對外 IP 拿不到(查 IP 的服務掛了、只有 IPv6…):不猜是哪一種,兩種可能都講
   **呼叫端的契約**:
     - confirm:true = 隔 5 分鐘重打一次,兩次都中才發通知(比照對帳器「兩次確認」的先例;誤報的代價高、多等一輪幾乎沒代價)。
     - 這些判讀**只通知、不自動停單、不移除金鑰**:金鑰真的失效時下單本來就會被 Binance 拒絕,對帳器自己有 HALT 的階梯。
     - 沒有結論的結果(斷網、時鐘、限速、不明)不算事:不因為斷網就叫人。 */
function recheckVerdict(prev, cur, ipThen, ipNow) {
  if (!prev || !prev.ok || prev.code === "SKIPPED_TESTNET" || !cur || cur.ok || INCONCLUSIVE.indexOf(cur.code) >= 0) return null;
  const reason = cur.code === "IP_OR_KEY" ? (!ipThen || !ipNow ? "REJECTED" : ipThen !== ipNow ? "IP_CHANGED" : "KEY_REJECTED")
    : cur.code === "BAD_SECRET" || cur.code === "BAD_KEY_FORMAT" ? "KEY_REJECTED" : "TRADING_LOST";
  return { level: VERDICT_LEVEL[reason], confirm: true, reason };
}

module.exports = { classify, check, recheck, recheckVerdict, nextPrev, sign, RECHECK_MS, INCONCLUSIVE, VERDICT_LEVEL };
