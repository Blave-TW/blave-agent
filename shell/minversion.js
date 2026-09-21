// Blave 電腦版 — 最低版本閘(主行程用;spec §13 第 4 點)。
// 契約:blave-canon output/backend/2026-09-21-desktop-min-version-contract.md
//
// 給安全事故用的:api 說「這個版本已停用」時,app 擋**新的下單啟動**與 **Blave 的 AI**,只留更新。平常 min_version 是 null。
//   - **失敗方向一律是放行(fail-open)**:打不到、不是 200、沒有 desktop 鍵、值的形狀不對、app 自己的版號解析不出來——都不擋。
//     api 掛掉不該讓所有人的下單停擺。
//   - 「打得到、而且明確回 null」是權威的解除;「打不到」不是——這一次執行期間已經確認被擋過,之後斷網不會因此解開
//     (不落地:重開 app 後從「不擋」開始,再問一次)。
//   - 擋的是**啟動類**指令(resume / resume_wait):已經在跑的下單不主動停——停單本身是有後果的動作(訊號該出場時沒人送單),
//     而且 spec §13 第 2 點是「下單中不強制換版」;暫停、改金額、移除金鑰這些安全方向的指令永遠放行。
//   - 聊天只擋 Blave 的 AI(那是我們的伺服器在替這個版本花錢、也是我們能負責的範圍);連自己 CLI 的人照常聊。
//   - 這是 client 自律的閘(外殼開源),不是硬邊界;真正斷掉舊版要在伺服器端做,不在這一批。
//
// 這個檔不 require electron;HTTP 由呼叫端注入(測試用假的)。
const CHECK_EVERY_MS = 4 * 3600 * 1000;   // 跟檢查更新同一個節拍
const FRESH_MS = 3600 * 1000;             // 按啟動 / 送出 Blave AI 回合前:上次的答案超過一小時就補問一次
const ENSURE_TIMEOUT_MS = 5000;           // 補問最多等這麼久:問不到就照手上的答案走(fail-open),不讓人卡在按鈕上
const MIN_RE = /^(0|[1-9]\d{0,3})(\.(0|[1-9]\d{0,3})){2}$/;   // api 保證的形狀;這裡自己再驗一次
const START_CMDS = new Set(["resume", "resume_wait"]);

/* "A.B.C" → [a, b, c];不合格回 null。strict = api 的 min_version(不收預發佈尾碼、前導零、v);
   不 strict = app 自己的版號:第一個 - 之後整段去掉再比(1.4.0-beta.1 視同 1.4.0)。 */
function parse(v, strict) {
  if (typeof v !== "string") return null;
  const core = strict ? v : v.split("-")[0];
  if (!MIN_RE.test(core)) return null;
  return core.split(".").map(Number);
}
/* app 版號 < min → true。任何一邊解析不出來 → false(不擋)。逐段數值比較,不是字串比較(1.10.0 > 1.9.0)。 */
function isBlocked(appVersion, minVersion) {
  const a = parse(appVersion, false), m = parse(minVersion, true);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== m[i]) return a[i] < m[i];
  return false;
}
/* public_tiers 的回應 → min_version 字串或 null(形狀不對一律 null) */
function minFromBody(body) {
  const v = body && typeof body === "object" && body.desktop && typeof body.desktop === "object" ? body.desktop.min_version : null;
  return parse(v, true) ? v : null;
}

/* opts:{ currentVersion, fetchTiers(force) → Promise<body | null>(null = 問不到), onChange?(state), onBlocked?(), now?, setTimer?, log? }
   state:{ blocked, min, current, checked_at } */
function createGate(opts) {
  const now = opts.now || (() => Date.now()), log = opts.log || (() => {});
  const setT = opts.setTimer || ((fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; });
  let min = null, checkedAt = 0, started = false, inflight = null;
  if (!parse(opts.currentVersion, false)) log("app version is not A.B.C (" + opts.currentVersion + "): the gate never blocks");
  const state = () => ({ blocked: isBlocked(opts.currentVersion, min), min, current: opts.currentVersion, checked_at: checkedAt });

  function refresh(force) {
    if (inflight) return inflight;
    inflight = (async () => {
      let body = null;
      try { body = await opts.fetchTiers(force === true); } catch (_) { /* 問不到 */ }
      if (body === null || body === undefined) return state();   // 問不到:手上的答案不動(沒問到過 = 不擋)
      const was = state().blocked;
      min = minFromBody(body); checkedAt = now();
      const st = state();
      if (st.blocked !== was) {
        if (opts.onChange) try { opts.onChange(st); } catch (_) { /* 畫面壞掉不影響閘 */ }
        if (st.blocked && opts.onBlocked) try { opts.onBlocked(); } catch (_) { /* 同上 */ }
      }
      return st;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  /* 動作前叫:答案太舊就補問一次,最多等 ENSURE_TIMEOUT_MS。回目前的 state。 */
  async function ensureFresh() {
    if (checkedAt && now() - checkedAt <= FRESH_MS) return state();
    await Promise.race([refresh(true), new Promise((r) => { const t = setTimeout(r, ENSURE_TIMEOUT_MS); if (t.unref) t.unref(); })]);
    return state();
  }
  return {
    start() { if (started) return false; started = true; refresh(false); setT(() => refresh(true), CHECK_EVERY_MS); return true; },
    refresh, ensureFresh, state,
    // 這個指令現在送不送得出去(只有啟動類會被擋)
    tradeAllowed: (cmd) => !(START_CMDS.has(cmd) && state().blocked),
    // 這一輪聊天送不送得出去(只擋 Blave 的 AI)
    turnAllowed: (connKind) => !(connKind === "blave" && state().blocked),
  };
}

module.exports = { createGate, isBlocked, parse, minFromBody, START_CMDS, CHECK_EVERY_MS, FRESH_MS };
