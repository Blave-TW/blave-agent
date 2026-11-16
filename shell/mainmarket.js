/* 主要市場(spec market-pref-2026-11-09 §2、§4;對帳沿用 desktop-market-pick v3 §2.1)。
   畫面一律讀本機 ui-prefs 那一份(mainMarket = { v, src }),帳號 agent_user_prefs.main_market 只拿來對帳:
   acct 查不到時 renderer 手上會留著舊值,直接畫帳號值會讓剛改過的值跳回去。
   src = 寫入當下登入者的 who(main.js acctWho),沒登入時選的寫 null。
   mktPend = { v, who }:登入著改值、送上帳號之前就記,成功才清;存在 ui-prefs,關 app 也不丟。
   mktAsk:這個安裝要不要問(只問新裝,啟動時判一次);mktSeen:第二步畫出來過幾次開 app(第二次就寫 mktAsk:false)。
   這個模組不碰 DOM、不碰 Electron:main.js 給讀寫 ui-prefs、送 POST、讀憑證的函式(tests/check_shell_main_market.js 直接 require 跑)。 */
const fs = require("fs");
const path = require("path");

const MARKETS = ["crypto", "twstock", "txf", "usstock", "all"];
const ENDPOINT = "/oauth/desktop/cloud/prefs";
// 外殼自己寫的檔,一個都不在才算新裝。telemetry.json 開 app 第一次就建(不論埋點開關),所以這一判要排在 tm() 之前
const INSTALL_MARKS = ["telemetry.json", "ui-prefs.json", "connect.json", "connect-key.bin", "blave-token.bin", "model-prefs.json"];
const WHO_RE = /^[0-9a-f]{32}$/;

const okV = (v) => typeof v === "string" && MARKETS.includes(v);
const locOf = (o) => {
  const m = o && o.mainMarket;
  return m && typeof m === "object" && okV(m.v) && (m.src === null || (typeof m.src === "string" && WHO_RE.test(m.src))) ? { v: m.v, src: m.src } : null;
};
const pendOf = (o) => {
  const p = o && o.mktPend;
  return p && typeof p === "object" && okV(p.v) && typeof p.who === "string" && WHO_RE.test(p.who) ? { v: p.v, who: p.who } : null;
};

/* 只問新裝:mktAsk 有值就用;沒有就看 userData 裡外殼的檔,判完寫回(寫不進去這次照記憶體的值,不重試)。
   要在任何 uiPrefsPatch、tm() 之前叫,否則新裝會被自己剛寫的檔判成舊裝 */
function askInit(dir, readPrefs, patchPrefs) {
  const o = readPrefs();
  if (typeof o.mktAsk === "boolean") return o.mktAsk;
  const ask = !INSTALL_MARKS.some((f) => fs.existsSync(path.join(dir, f)));
  try { patchPrefs({ mktAsk: ask }); } catch (_) { /* 權限、磁碟滿:下次開 app 會被 telemetry.json 判成舊裝,可以接受 */ }
  return ask;
}

/* opts:{ readPrefs() → object, patchPrefs(patch), getCreds() → { token, appSecret, who } | null, post(url, body) → Promise<{ status, body }>,
   apiBase, ask(askInit 的結果), onChange(state)?(對帳改了本機值才叫) } */
function createMainMarket(opts) {
  // 這次開 app 問不問:啟動時定下來。shown() 寫進檔的 false 只管下次開 app,這次登入失敗回第一步、重連時照樣再問
  let askRun = opts.ask === true;
  let fresh = false;          // 這次開 app 在連結畫面上、沒登入時剛選的(§2.4 第 2 條);進工作頁那一刻 seal 收掉
  let busy = false;           // 帳號寫入在途
  let seenThisRun = false;
  const off = new Set();      // 這次開 app 期間這個 who 的 api 不收(舊 api 回 BAD_CURRENCY／BAD_MAIN_MARKET):不再送,旗標留著下次開 app 再送
  const read = () => { try { const o = opts.readPrefs(); return o && typeof o === "object" ? o : {}; } catch (_) { return {}; } };
  const patch = (p) => { try { opts.patchPrefs(p); return true; } catch (_) { return false; } };
  const creds = () => { try { const c = opts.getCreds(); return c && c.token ? c : null; } catch (_) { return null; } };
  const whoNow = () => { const c = creds(); return c ? c.who : null; };
  function get() {
    const o = read(), l = locOf(o);
    return { v: l ? l.v : null, src: l ? l.src : null, ask: askRun };
  }
  // 有了值(答了、跳過、採了帳號值)就不再問:之後換人把本機值清掉,連結畫面也不再出第二步
  const answered = () => { askRun = false; patch({ mktAsk: false }); };
  const changed = () => { if (opts.onChange) try { opts.onChange(get()); } catch (_) { /* 畫面壞掉不影響寫入 */ } };

  async function push(v, c) {
    patch({ mktPend: { v, who: c.who } });
    if (busy || off.has(c.who) || !c.appSecret) return;
    busy = true;
    let res = null;
    try { res = await opts.post(opts.apiBase + ENDPOINT, { token: c.token, app_secret: c.appSecret, main_market: v }); } catch (_) { /* 連不上:旗標留著 */ }
    busy = false;
    if (whoNow() !== c.who) return;   // 在途時登出或換人:下一次對帳會丟掉這個人的旗標
    const code = res && res.body && res.body.error_code;
    if (res && res.status === 400 && (code === "BAD_CURRENCY" || code === "BAD_MAIN_MARKET")) { off.add(c.who); return; }
    if (!res || res.status !== 200) return;
    const p = pendOf(read());
    if (p && p.who === c.who && p.v === v) patch({ mktPend: null });
    else if (p && p.who === c.who) { const cur = creds(); if (cur && cur.who === c.who) push(p.v, cur); }   // 在途時又改了值:補送最後那個
  }

  /* 改值(第二步、設定列)。先寫本機、畫面照換,登入著才送帳號;沒登入的在第二步選的記成 fresh */
  function set(v, o) {
    if (!okV(v)) return get();
    const c = creds();
    if (!patch({ mainMarket: { v, src: c ? c.who : null } })) return get();
    answered();
    if (c) { fresh = false; push(v, c); } else fresh = !!(o && o.fresh);
    return get();
  }
  /* 從連結畫面進工作頁的那一刻:剛選的值這時已經登入(Blave 登入完成才進),就寫上這個帳號、以剛選的為準;沒登入就不再算剛選的 */
  function seal() {
    if (!fresh) return get();
    fresh = false;
    const c = creds(), l = locOf(read());
    if (c && l && l.src === null) { patch({ mainMarket: { v: l.v, src: c.who } }); push(l.v, c); }
    return get();
  }
  /* 第二步畫出來:每次開 app 記一次;第二次開 app 還畫出來(上次開著就關掉)就寫 mktAsk:false,這次照問、下次不問 */
  function shown() {
    if (seenThisRun) return get();
    seenThisRun = true;
    const n = (Number.isInteger(read().mktSeen) ? read().mktSeen : 0) + 1;
    patch(n >= 2 ? { mktSeen: n, mktAsk: false } : { mktSeen: n });
    return get();
  }
  /* account_status 回來(main.js accountStatus):b 沒有 main_market 這個鍵 = 舊 api,不對帳 */
  function reconcile(who, b) {
    if (!who || !b || typeof b !== "object" || !("main_market" in b)) return;
    const acctV = okV(b.main_market) ? b.main_market : null;
    const o = read(), loc = locOf(o);
    let pend = pendOf(o);
    if (pend && pend.who !== who) { patch({ mktPend: null }); pend = null; }   // 換人:不把上一個人的值寫給這個人
    if (pend) { const c = creds(); if (c && c.who === who) push(pend.v, c); return; }   // 待送中不准用帳號值蓋本機
    if (loc && loc.src === null) {
      if (acctV === null || fresh) { const c = creds(); fresh = false; if (c && c.who === who) { patch({ mainMarket: { v: loc.v, src: who } }); push(loc.v, c); } return; }
      patch({ mainMarket: { v: acctV, src: who } }); answered(); changed(); return;
    }
    if (acctV !== null) {
      if (!loc || loc.v !== acctV || loc.src !== who) { patch({ mainMarket: { v: acctV, src: who } }); answered(); changed(); }
      return;
    }
    if (loc && loc.src !== who) { patch({ mainMarket: null }); changed(); }   // 帳號沒值、本機是別人的:當沒值
  }
  // 本機回合的旗標;all 與沒設不帶(runtime 那邊同樣只認四個市場)
  function args() { const v = get().v; return v && v !== "all" ? ["--main-market=" + v] : []; }
  return { get, set, seal, shown, reconcile, args };
}

module.exports = { createMainMarket, askInit, MARKETS, INSTALL_MARKS, ENDPOINT };
