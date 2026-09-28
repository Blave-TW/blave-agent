/* 這個帳號自己的 Blave 餘額(TWD):POST /oauth/desktop/balance,body 帶帳號 token + app_secret(同 /plan/start)。
   只在主行程打:兩顆憑證不進 renderer、不進 agent 的環境。帳號狀態(account_status)刻意不回餘額——那支只憑帳號 token
   就打得到,而策略碼讀得到那顆 token。
   回 { balance: 數字(可能是負的), trial: 數字 | null } 或 null(讀不到)。**非 200 一律 null**(401 舊登入 / 429 / 503 /
   api 還沒部署的 404 / 連不上 / 欄位不是數字):畫面畫「—」,不把讀不到畫成 0(那會被讀成「這個人沒錢」)。
   節流:HOLD_MS 內重複讀用上一次的答案(讀不到也算一次答案——429 之後馬上再打只會再吃一次 429);api 是每帳號每分鐘 20 次。
   不寫檔、不 log。登出 / 換帳號由 main.js 呼叫 reset()。 */
const ENDPOINT = "/oauth/desktop/balance";
const HOLD_MS = 10 * 1000;
const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

function interpret(r) {
  const b = r && r.status === 200 && r.body && typeof r.body === "object" ? r.body : null;
  if (!b || num(b.balance) === null) return null;
  return { balance: b.balance, trial: num(b.trial_ai_credit_left) };
}

function createBalance({ apiBase, post, getCreds, now }) {
  const clock = now || (() => Date.now());
  let last = null, flight = null;
  async function read() {
    const c = getCreds();
    if (!c || !c.token || !c.appSecret) return null;
    if (last && last.token === c.token && clock() - last.at < HOLD_MS) return last.value;
    if (flight && flight.token === c.token) return flight.p;
    const p = (async () => {
      let value = null;
      try { value = interpret(await post(apiBase + ENDPOINT, { token: c.token, app_secret: c.appSecret })); } catch (_) { value = null; }
      const cur = getCreds();
      if (!cur || cur.token !== c.token) return null;   // 在途時登出 / 換了帳號:上一個帳號的數字不回給畫面、也不記
      last = { token: c.token, at: clock(), value };
      return value;
    })();
    flight = { token: c.token, p };
    try { return await p; } finally { if (flight && flight.p === p) flight = null; }
  }
  return { read, reset: () => { last = null; flight = null; } };
}

module.exports = { createBalance, interpret, ENDPOINT, HOLD_MS };
