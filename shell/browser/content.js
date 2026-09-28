// 網頁內容 → 交給 agent 的形狀(純函式;tests/check_shell_browser_content.js)。
// 契約:.claude/output/specs/desktop-browser-mcp-interface-2026-09-26.md §2 信封、§3.1 搜尋、§3.6 read 的 part。
// 網頁寫的字都是不可信資料:剝控制字元與零寬字元,並把我們自己的對話標記換掉——頁面偽造不出「使用者說」的格式。
"use strict";

// 鏡射 runtime/session_store.py 的 SCAFFOLD_RE(逐字照抄;那邊改這邊跟著改,測試釘住兩邊一致)。
const SCAFFOLD_RE = /^(?:user:\s|assistant:\s|\[工作頁狀態[:：]|\[使用者這次的訊息\]|\[用中文回覆這則訊息|\[The user wrote in English|\[Reply in the language of the user message|\[近期對話|\[過去對話摘要\]|\[Runtime 規則)/gm;
// 隱形字一律剝:所有格式字元 \p{Cf}(零寬、雙向控制、BOM、軟連字號 U+00AD、U+061C、U+180E、標籤字元 U+E0000–E007F——
// 「ASCII smuggling」隱形指令的載體)、行 / 段分隔 U+2028/2029、控制字元 \p{Cc}(保留 \t \n)
const CTRL_RE = /[\p{Cf}\u2028\u2029]|(?![\t\n])\p{Cc}/gu;

function scrub(s, max) {
  let t = String(s == null ? "" : s);
  if (max && t.length > max) t = t.slice(0, max);
  t = t.replace(/\r\n?/g, "\n").replace(CTRL_RE, "");
  // 用全形括號代替:語意留著給 agent 看得懂,但不再是我們的標記
  return t.replace(SCAFFOLD_RE, (m) => "〔page text〕" + m.replace(/^\[/, "［").replace(/^(user|assistant):/, "$1："));
}
/** 物件 / 陣列裡的每個字串都 scrub。 */
function scrubDeep(v, max) {
  if (typeof v === "string") return scrub(v, max);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, max));
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = scrubDeep(v[k], max); return o; }
  return v;
}
/** 信封:頁面來的字放 untrusted_content,網址與標題在外層。 */
function envelope(url, title, content, extra) {
  return Object.assign({ ok: true }, extra || {}, { source_url: scrub(url, 2000), title: scrub(title, 300), untrusted_content: scrubDeep(content, 200000) });
}

// ── 搜尋結果正規化 ──
const ENGINE_HOST_RE = /(^|\.)(google\.[a-z.]+|googleusercontent\.com|gstatic\.com|duckduckgo\.com|webcache\.googleusercontent\.com)$/i;
/** Google 的 /url?q= 與 DDG 的 /l/?uddg= 包裝剝掉;回真網址或 null。 */
function unwrap(href) {
  let u; try { u = new URL(String(href)); } catch (_) { return null; }
  const h = u.hostname.toLowerCase();
  if (/(^|\.)google\./.test(h) && u.pathname === "/url") { const q = u.searchParams.get("q") || u.searchParams.get("url"); return q ? unwrap(q) : null; }
  if (/(^|\.)duckduckgo\.com$/.test(h) && u.pathname.startsWith("/l/")) { const q = u.searchParams.get("uddg"); return q ? unwrap(q) : null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (ENGINE_HOST_RE.test(h)) return null;   // 搜尋引擎自家的頁(相關搜尋、圖片、快取)
  u.hash = "";
  return u.href;
}
/** serp() 的原始輸出 → [{rank,title,url,snippet}]:剔廣告、剔引擎自家、去重,取前 count 筆。 */
function normalizeSerp(raw, count) {
  const out = [], seen = new Set();
  for (const it of (raw && raw.items) || []) {
    if (!it || it.ad) continue;
    const url = unwrap(it.href);
    if (!url || seen.has(url)) continue;
    const title = String(it.title || "").trim();
    if (!title) continue;
    seen.add(url);
    out.push({ rank: out.length + 1, title: title.slice(0, 300), url, snippet: String(it.snippet || "").trim().slice(0, 400) });
    if (out.length >= count) break;
  }
  return out;
}

// ── browser_read 的 part ──
const READ_CHUNK = 12000;
/** extract() 的輸出 + 參數 → { content, next_offset?, total_chars? } 或 { error }。budget(n) 回實際可給的字數。 */
function readPart(ex, args, budget) {
  const part = args.part || "full";
  const small = part === "meta" ? ex.meta : part === "outline" ? { headings: ex.headings.map((h) => ({ id: h.id, level: h.level, text: h.text })) } : part === "links" ? { links: ex.links } : null;
  if (small) {   // 精簡讀取也計入預算(通常很小)
    const n = JSON.stringify(small).length;
    return budget(n) < n ? { error: "budget_exhausted", message: "the read budget for this turn (120,000 characters) is used up; answer with what you have" } : { content: small };
  }
  let text = ex.markdown, base = 0;
  if (part === "section") {
    const key = String(args.section || "").trim();
    if (!key) return { error: "invalid_args", message: "section is required when part=section" };
    const hs = ex.headings;
    let i = hs.findIndex((h) => h.id === key);
    if (i < 0) { const k = key.toLowerCase(); i = hs.findIndex((h) => h.text.toLowerCase().includes(k)); }
    if (i < 0) return { error: "invalid_args", message: "no heading matches section; call part=outline first" };
    const end = hs.slice(i + 1).find((h) => h.level <= hs[i].level);
    base = hs[i].at; text = ex.markdown.slice(hs[i].at, end ? end.at : undefined);
  } else if (part !== "full") return { error: "invalid_args", message: "part must be full|meta|outline|section|links" };
  const off = Math.max(0, Math.floor(Number(args.offset) || 0));
  const want = Math.min(READ_CHUNK, Math.max(0, text.length - off));
  const give = Math.min(want, budget(want));
  if (want > 0 && give === 0) return { error: "budget_exhausted", message: "the read budget for this turn (120,000 characters) is used up; answer with what you have" };
  const chunk = text.slice(off, off + give);
  const next = off + give < text.length ? off + give : null;
  // span = 這次讀進來的那一段在整份 markdown 裡的字元起訖:主行程用它找出讀了哪幾個區塊(頁面上的讀取帶只畫這幾塊)
  return { content: chunk, next_offset: next, total_chars: text.length, section_start: part === "section" ? base : undefined, span: [base + off, base + off + give] };
}

/** 中繼頁:標題是轉址 / 載入中 / Cloudflare 那類固定字樣,或讀回來正文不到 200 字而且看不出是最終頁。開了但沒讀到內容,不算已讀
 *  (spec-turn-status-summary 瀏覽卡節;例:NewsNow 的「Loading story…」)。
 *  正文短但確實是最終頁(#209,example.com 那種一個標題兩行字):文件載完(settled = 分頁 ready 且不是 partial、readyState complete)、
 *  沒有 meta refresh 等著轉走、有標題、正文至少一句 → 是內容,算已讀。空殼 SPA(正文空)與轉址中繼頁(有 refresh / 沒載完)照舊抓得到。 */
// 標題「整個」就是轉址 / 載入中那句才算(「Bitcoin loading up for breakout」這種正常標題不算;稽核 P2-5)
const RELAY_TITLE_RE = /^\s*(?:loading|redirect(?:ing)?|just a moment|please wait)\s*(?:\.\.\.|…|\.)?\s*$/i;
// 擋牆頁(擋廣告攔截、請關閉 ad blocker):正文幾乎只有這段勸說,跟中繼頁一樣算沒讀到(稽核 B1:benzinga)
const WALL_BODY_RE = /ad ?blocker (?:is )?(?:on|enabled|detected)|(?:disable|turn off|pause) (?:your )?ad ?block(?:er)?|please support our site|whitelist (?:us|this site)/i;
const WALL_BODY_MAX = 2000;
const SHORT_BODY_MIN = 40;
function isRelay(ex, title, settled) {
  const body = String((ex && ex.markdown) || "").replace(/\s+/g, " ").trim();
  const ttl = String(title || (ex && ex.meta && ex.meta.title) || "").trim();
  if (RELAY_TITLE_RE.test(ttl) || (body.length < WALL_BODY_MAX && WALL_BODY_RE.test(body))) return true;
  if (body.length >= 200) return false;
  const doc = ex && ex.doc;
  return !(settled === true && !!doc && doc.complete === true && doc.refresh !== true && ttl.length > 0 && body.length >= SHORT_BODY_MIN);
}

module.exports = { scrub, scrubDeep, envelope, unwrap, normalizeSerp, readPart, isRelay, SCAFFOLD_RE, READ_CHUNK };
