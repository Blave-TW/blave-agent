// 搜尋引擎的機器人驗證頁:判別表、等用戶過驗證的那一段、搜尋之間的間隔(純邏輯,不 require electron;tests/check_shell_browser_verify.js)。
// 規格:設計師 designer-spec-search-verify(Wei 2026-09-28「先做 A」)。
//
// 紅線:外殼與 agent 都**不解驗證、不對驗證頁做任何操作**——不點、不填、不送按鍵、不跑腳本去動驗證元件、不呼叫解題服務、
// 不為了躲偵測去改 user-agent / 指紋 / cookie。這裡做的只有三件事:認出這是驗證頁 → 把頁面交給用戶 → 等它離開。
// 等的期間只看三樣:用戶按了哪顆鈕、分頁有沒有導覽走(主行程的導覽事件與網址)、人還在不在。網址還是驗證頁時不在頁面裡跑任何東西。
"use strict";

// 沒人理多久算逾時;用戶動手之後從那一刻起再給多久(圖片題一次要 20–60 秒,不該做到一半被切掉)。合計最多 240 秒
const VERIFY_WAIT_MS = 120000, VERIFY_TOUCHED_MS = 120000;
// 一次 browser_search 呼叫(含排在前一次搜尋後面等的時間)最晚這麼久要回:引擎那一端的工具呼叫有自己的逾時
// (Codex 由 runtime/codex_engine.py 設成 600 秒;HTTP 用戶端常見的上限是 300 秒),等驗證不能等到呼叫本身先斷
const SEARCH_CALL_MAX_MS = 270000, VERIFY_MIN_MS = 20000;   // 剩不到 VERIFY_MIN_MS 就不問了(來不及過一次驗證)
// 按「交還 agent」的當下頁面常常正在導回搜尋結果:等換頁落定再判,最多 HANDBACK_SETTLE_MS;還沒開始換頁的,給它 HANDBACK_GRACE_MS 開始
const HANDBACK_SETTLE_MS = 8000, HANDBACK_GRACE_MS = 1000;
// 同一輪的搜尋一個一個來,前一次結束到下一次開始至少隔這麼久(實測 2 秒內連發 5 次就被要求驗證)
const SEARCH_GAP_MS = 4000;

/* 搜尋引擎表:搜尋網址怎麼組、哪些網址是它的搜尋頁、它的驗證頁怎麼認。
   verify.path = 網址就看得出來的驗證頁;marks / text = 頁面上的標記(只讀,inpage.js serp 用);unless = 有這個就是結果頁,不是驗證頁
   (搜尋「異常流量」時結果摘要裡也會有這幾個字)。要加引擎或驗證頁換了樣子,改這張表 */
/* Google 的主機名:google.com、各國網域(google.de、google.co.jp、google.com.tw)與它們的子網域。字尾要整個對上——
   `google.evil.com`、`google.com.evil.io` 是別人的網域(稽核 P2-4)。policy.js 的 searchEngine 有同一條(那支不 require 別的檔) */
const GOOGLE_HOST = /(^|\.)google\.(?:com|[a-z]{2}|com?\.[a-z]{2})$/;
const ENGINES = {
  google: {
    name: "Google", host: GOOGLE_HOST, search: /^\/(search|webhp)/,
    url: (q, hl, n) => "https://www.google.com/search?hl=" + hl + "&num=" + n + "&q=" + encodeURIComponent(q),
    verify: { path: /^\/sorry(\/|$)/, marks: "#captcha-form,form[action*='sorry'],iframe[src*='recaptcha']", text: "unusual traffic|異常流量|异常流量", unless: "#rso a h3" },
  },
  ddg: {
    name: "DuckDuckGo", host: /(^|\.)duckduckgo\.com$/, search: /^\//,
    url: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q),
    verify: { path: /^\/anomaly/, marks: "form[action*='anomaly'],#challenge-form,.anomaly-modal", text: "bots use duckduckgo|not a robot|challenge", unless: ".result__a" },
  },
};
const ORDER = ["google", "ddg"];   // 退路的順序

function parse(raw) { try { const u = new URL(String(raw || "")); return u.protocol === "http:" || u.protocol === "https:" ? u : null; } catch (_) { return null; } }
/** 這個網址是哪一個引擎的(驗證頁也算它的);不是搜尋引擎回 null */
function engineOf(raw, engines) {
  const u = parse(raw); if (!u) return null;
  const E = engines || ENGINES, h = u.hostname.toLowerCase();
  return Object.keys(E).find((k) => E[k].host.test(h)) || null;
}
/** 光看網址就知道是驗證頁 → 引擎代號;否則 null */
function verifyPage(raw, engines) {
  const E = engines || ENGINES, k = engineOf(raw, E);
  return k && E[k].verify.path.test(parse(raw).pathname) ? k : null;
}
/** 這個網址是不是那個引擎的搜尋頁(驗證頁不算) */
function searchPage(raw, engine, engines) {
  const E = engines || ENGINES;
  return engineOf(raw, E) === engine && !verifyPage(raw, E) && E[engine].search.test(parse(raw).pathname);
}
/** 交給頁面裡那支只讀的判別(inpage.js serp)的標記:regex 轉成字串才送得過去 */
function marks(engine, engines) {
  const v = (engines || ENGINES)[engine].verify;
  return { path: v.path.source, marks: v.marks, text: v.text, unless: v.unless || "" };
}
/** 還有沒有下一個引擎可以退 */
function nextEngine(engine) { const i = ORDER.indexOf(engine); return i >= 0 && i + 1 < ORDER.length ? ORDER[i + 1] : null; }

/**
 * 等用戶過驗證。不碰頁面:d 的每一支都只讀主行程自己的狀態。
 * d: { now(), sleep(ms), alive() → 分頁與回合都還在, present() → 視窗在畫面上, choice() → 用戶按的鈕(null | "done" | "ddg" | "skip"),
 *      touchedAt() → 用戶第一次動手的時間戳(沒動過 = 0), left(force?) → Promise<bool> 分頁已經導覽回搜尋結果
 *      (force = 用戶按了交還:同一次導覽已經判過也要重判),
 *      loading()? → 分頁正在換頁(主行程自己的載入狀態),
 *      deadline?(這次呼叫最晚要回的時間戳), waitMs?, touchedMs? }
 * 回 "passed"(過了)| "exit"(按了出口)| "gave_up"(按了交還、換頁落定之後還在驗證頁)| "timeout" | "absent"(人不在)| "closed"
 */
async function waitVerify(d) {
  const waitMs = d.waitMs || VERIFY_WAIT_MS, touchedMs = d.touchedMs || VERIFY_TOUCHED_MS, start = d.now();
  for (;;) {
    if (!d.alive()) return "closed";
    if (await d.left()) return "passed";
    const c = d.choice();
    if (c === "done") {
      // 「交還 agent」=「我弄好了」。過完驗證、頁面正在導回搜尋結果時按下去的,上面那一次查到的是「還在載」(稽核 P2-6):
      // 等換頁落定再判;落定之後還沒離開才當沒過,不再問第二次。
      // 這一段的 left 一律帶 force:平常的輪詢一次導覽只判一次,判成「還沒過」之後同一次導覽就不再看——
      // 那一次判早了(頁面還沒長好)的話,不重判就會把已經過了的驗證當成放棄、改去 DuckDuckGo 重搜
      const t0 = d.now(), until = Math.min(t0 + HANDBACK_SETTLE_MS, d.deadline || Infinity);
      while (d.alive() && d.now() < until && ((d.loading && d.loading()) || d.now() - t0 < HANDBACK_GRACE_MS)) {
        await d.sleep(250);
        if (await d.left(true)) return "passed";
      }
      if (!d.alive()) return "closed";
      return (await d.left(true)) ? "passed" : "gave_up";
    }
    if (c) return "exit";
    if (!d.present()) return "absent";
    const touched = d.touchedAt(), end = touched ? Math.min(touched + touchedMs, start + waitMs + touchedMs) : start + waitMs;
    if (d.now() >= Math.min(end, d.deadline || Infinity)) return "timeout";
    await d.sleep(250);
  }
}

/** 搜尋的閘門:一次一個,前一次結束到下一次開始至少隔 gapMs。o: { now(), sleep(ms), gapMs? } */
function createGate(o) {
  const gap = o.gapMs == null ? SEARCH_GAP_MS : o.gapMs;
  let tail = Promise.resolve(), last = 0;
  return {
    run(fn) {
      const p = tail.then(async () => {
        const wait = last ? last + gap - o.now() : 0;
        if (wait > 0) await o.sleep(wait);
        try { return await fn(); } finally { last = o.now(); }
      });
      tail = p.catch(() => {});
      return p;
    },
  };
}

/* 沒搜到的原因(search_unavailable 的 reason)與寫給模型看的那一句 */
const REASONS = {
  user_skipped: "the search engine asked for a robot check and the user chose not to do it",
  timeout: "the search engine asked for a robot check and it was not completed in time",
  no_user: "the search engine asked for a robot check and nobody is at the app to do it",
  captcha: "the search engine asked for a robot check",
  failed: "Google and DuckDuckGo both failed to load or returned nothing",
};
const NO_RETRY = " Do not search again to get around the check.";
const UNAVAILABLE_HINT = " Open known addresses with browser_open / browser_open_many instead, and say in the first sentence of your reply that this time the web could not be searched and which sites you opened directly.";
function unavailable(reason) {
  const r = REASONS[reason] ? reason : "failed";
  return { reason: r, message: "web search is not available right now: " + REASONS[r] + "." + (r === "failed" ? "" : NO_RETRY) + UNAVAILABLE_HINT };
}
/** waitVerify 的結果 → search_unavailable 的 reason */
const reasonOf = (got) => ({ exit: "user_skipped", gave_up: "user_skipped", timeout: "timeout", absent: "no_user", closed: "no_user" }[got] || "captcha");

const REFUSED = "this tab is a search engine's robot check. It is the user's to do: you do not click, fill, press keys, read, snapshot or capture on it, and you do not try another tool or another address to get past it. browser_search is already waiting for the user; when it returns, go on from its result";

module.exports = { ENGINES, GOOGLE_HOST, ORDER, VERIFY_WAIT_MS, VERIFY_TOUCHED_MS, SEARCH_CALL_MAX_MS, VERIFY_MIN_MS, SEARCH_GAP_MS, HANDBACK_SETTLE_MS, HANDBACK_GRACE_MS, REASONS, REFUSED, engineOf, verifyPage, searchPage, marks, nextEngine, waitVerify, createGate, unavailable, reasonOf };
