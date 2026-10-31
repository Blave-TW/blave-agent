/* 對話文字離開這台電腦之前的遮蔽(spec mobile-agent-chat-mvp §4.3;主行程用)。
 *
 * 規則與順序逐條照 api openclaw/redact.py;兩邊跑同一份 tests/fixtures/redact_cases.json(逐字比對兩份檔,
 * tests/check_shell_redact.js)。改一條規則就兩邊與 fixture 一起改。
 * 第 1 條(已知的值)只有這裡有:值由呼叫端交進來,只在記憶體比對,不寫檔、不 log、不回傳。
 * 第 6 條的 HOME_RE、LONG_TOKEN_RE 直接用 mobileview.js 那組物件(與 api desktop_portfolio 逐字比對過),本體不動;
 * 這是跟 api 唯一已知的差異:HOME_RE 是 gi、沒有 u,Users 或磁碟代號裡的 ſ / K(U+212A)/ İ / ı,
 * 以及使用者名稱旁的 \x1c–\x1f、\x85、U+FEFF,兩邊遮法不同;少遮的那側由 api 收到後自己再跑一次 2–7 條補上
 * (/relay/sync、串流文字欄位、推播),其他欄位只有這一道。共用 fixture 沒有這類案例。
 * 網址／路徑 query 跟 api 一樣改寫成 querySub(那兩條 regex 是平方級)。
 * 盡力遮,不保證認得出每一種秘密。
 */
const fs = require("fs");
const path = require("path");
const { HOME_RE, LONG_TOKEN_RE } = require("./mobileview");

const MASK = "⟦R⟧";
const EXCLUDED = "⟦R:msg⟧";
const MAX_MASKS = 5;
const INPUT_MAX = 64 * 1024;   // 碼位數,= api INPUT_MAX
const MNEMONIC_MIN_WORDS = 12;
const LONG_TOKEN_MIN = 32;   // = LONG_TOKEN_RE 的 {32,}

// Python str 的 \s(str.isspace)跟 JS 的 \s 差三組字元(\x1c-\x1f、\x85 / ﻿):自己寫的這幾條照 Python 那一組
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const NUMBERING_RE = /^[0-9]+[.)]?$/;
const LEADING_NUMBER_RE = /^[0-9]+[.)]/;   // 「1.abandon」(編號黏在字前面)拿掉編號
const WORD_EDGE = ".,;:!?\"'()[]{}";
const WORD_SPLIT_RE = new RegExp("[" + WS + "\"',\\[\\]{}\\-_]+", "u");   // JSON 陣列、- 或 _ 串起來的助記詞一樣切得開
/* 第 4 條(名=值)遮兩組區間的聯集(= api _rule4_spans,48377c65):
   - refSpans:ed1b840c 那版的區間,線性算法(一串名字字元含關鍵字,接 ["']?\s*[:=]\s*["']?,再接 6 個以上
     [^\s"'`,;&])。它遮過的永遠照遮,另一組怎麼改都不會讓它漏;
   - newSpans:這版加的,只會多遮:全形 ：＝、中文關鍵字;值在下一行時掃描會進到那個值裡——它可能自己就是
     name:(空的 api_key: 下一行是 passphrase: x),那它的值也遮。同一行不會:password=Monkey2024: please 是一個值。
   重疊或相鄰的區間併成一個遮罩,只算一次 MAX_MASKS。
   名字照 api 的 (?i):[A-Za-z] 也吃 İ ı ſ K(U+0130、U+0131、U+017F、U+212A)。i 加 u 只摺得到 ſ 和 K,
   İ ı 寫進字元類;關鍵字比對前把 İ ı 換成 i(關鍵字裡只有 private 帶 i) */
const NAME_CH = "A-Za-z0-9_.\\-\\u0130\\u0131";
const NAME_RUN_RE = new RegExp("(?<![" + NAME_CH + "])[" + NAME_CH + "]+", "giu");
const REF_KW_RE = /key|secret|token|passphrase|password|passwd|pwd|private/iu;
const REF_TAIL_RE = new RegExp("[\"']?[" + WS + "]*[:=][" + WS + "]*[\"']?([^" + WS + "\"'`,;&]{6,})", "yu");
const KV_NAME_PART_RE = new RegExp("(?<![" + NAME_CH + "\\u4e00-\\u9fff])[" + NAME_CH + "\\u4e00-\\u9fff]+[\"']?[" + WS + "]*[:=：＝]([" + WS + "]*)[\"']?", "giu");
const KV_TOKEN_RE = new RegExp("[^" + WS + "\"'`,;&]{6,}", "yu");
const KV_NAME_RE = /key|secret|token|passphrase|password|passwd|pwd|private|密碼|密码|金鑰|金钥|私鑰|私钥|密鑰|密钥|口令/iu;
const DOTLESS_RE = /[\u0130\u0131]/gu;
const hasKw = (re, s) => re.test(s.replace(DOTLESS_RE, "i"));
// Authorization 標頭:只遮 token。api 這條也是 (?i),İ ı 一樣寫進字元類
const BEARER_RE = new RegExp("(?<![A-Za-z0-9_\\u0130\\u0131])(bearer[" + WS + "]+)([A-Za-z0-9._~+/\\-\\u0130\\u0131]{16,}=*)", "giu");
const PREFIX_RE = new RegExp(
  // Telegram bot token 自己一條 lookbehind:它常常緊接在 API 網址的 "bot" 後面
  "(?<![0-9])[0-9]{8,10}:AA[A-Za-z0-9_\\-]{30,}|"
  + "(?<![A-Za-z0-9_\\-.])eyJ[A-Za-z0-9_\\-]+\\.eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+"
  + "|(?<![A-Za-z0-9_])(?:"
  + "sk-[A-Za-z0-9_\\-]{16,}"
  + "|(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])"
  + "|gh[pousr]_[A-Za-z0-9]{20,}"
  + "|github_pat_[A-Za-z0-9_]{20,}"
  + "|xox[abprs]-[A-Za-z0-9\\-]{10,}"
  + "|AIza[0-9A-Za-z_\\-]{35}"
  + "|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F])"
  + ")", "g");
const HEX_RE = /^[0-9a-fA-F]+$/;

const WORDS_PATH = path.join(__dirname, "bip39_english.txt");
let _words = null;
function bip39() {
  if (!_words) _words = new Set(fs.readFileSync(WORDS_PATH, "utf8").split("\n").map((w) => w.trim()).filter((w) => w && !w.startsWith("#")));
  return _words;
}

const stripEdge = (s) => {
  let a = 0, b = s.length;
  while (a < b && WORD_EDGE.includes(s[a])) a++;
  while (b > a && WORD_EDGE.includes(s[b - 1])) b--;
  return s.slice(a, b);
};
function hasMnemonic(text) {
  const words = bip39();
  let run = 0;
  for (const tok of text.split(WORD_SPLIT_RE)) {
    if (!tok || NUMBERING_RE.test(tok)) continue;
    if (words.has(stripEdge(tok.replace(LEADING_NUMBER_RE, "")).toLowerCase())) { if (++run >= MNEMONIC_MIN_WORDS) return true; }
    else run = 0;
  }
  return false;
}

// 不加這層,binance_funding_rate_strategy_v2 這種策略名會被遮。0x 開頭的 hex(EVM 私鑰、交易雜湊)也算 hex
function longTokenIsSecret(tok) {
  const hasAll = /[A-Z]/.test(tok) && /[a-z]/.test(tok) && /[0-9]/.test(tok);
  const bare = tok.slice(0, 2) === "0x" || tok.slice(0, 2) === "0X" ? tok.slice(2) : tok;
  return hasAll || HEX_RE.test(bare);
}

/* 像路徑字的一段:小寫起頭的 camelCase(可夾縮寫,getHTTPData2)／帶數字、大寫起頭的字、縮寫接小寫(HTTPserver)、
   全大寫帶數字、7–40 碼小寫 hex(短 commit)、數字接單位(4h、15m)或數字大寫數字(2026Q4),用 _ . - 串起來。
   = api _PATH_SEGMENT_RE(48377c65)逐字同一條:
   每一段連續的小寫／數字／大寫都吃到底(lookahead),一個單元用 (?=(…))\1 原子化,只能停在 _ . - 或段尾——不回溯 */
const L = "[a-z]+(?![a-z])", D = "[0-9]+(?![0-9])";
const CAMEL = "(?:[A-Z]" + L + "|[A-Z]{2,}(?=[A-Z][a-z])|[A-Z]?" + D + ")*";
const UNIT = "(?=((?:" + L + CAMEL + "[A-Z]?|[A-Z]" + L + CAMEL + "|[A-Z]{2,}(?![A-Z])(?:" + L + ")?"
  + "|[A-Z]+(?![A-Z])(?:" + D + ")?|[0-9a-f]{7,40}|" + D + "(?:" + L + "|[A-Z]+(?![A-Z])(?:" + D + ")?)?"
  + ")(?=[_.\\-]|$)))\\1";
const WORDISH_RE = new RegExp("^" + UNIT + "(?:[_.\\-]" + UNIT.replace("\\1", "\\2") + ")*$");
const wordish = (seg) => WORDISH_RE.test(seg);
const EXT_RE = /\.[A-Za-z0-9]/y;
const cpLen = (s) => Array.from(s).length;
function refSpans(text) {
  const spans = [];
  let cursor = 0, run;
  NAME_RUN_RE.lastIndex = 0;
  while ((run = NAME_RUN_RE.exec(text)) !== null) {
    if (run.index < cursor || !hasKw(REF_KW_RE, run[0])) continue;
    REF_TAIL_RE.lastIndex = run.index + run[0].length;
    const tail = REF_TAIL_RE.exec(text);
    if (tail) {
      cursor = tail.index + tail[0].length;
      spans.push([cursor - tail[1].length, cursor]);
    }
  }
  return spans;
}
function newSpans(text) {
  const spans = [];
  let pos = 0, m;
  for (;;) {
    KV_NAME_PART_RE.lastIndex = pos;
    if ((m = KV_NAME_PART_RE.exec(text)) === null) return spans;
    pos = m.index + m[0].length;
    if (!hasKw(KV_NAME_RE, m[0])) continue;
    KV_TOKEN_RE.lastIndex = pos;
    const v = KV_TOKEN_RE.exec(text);
    if (!v) continue;
    spans.push([pos, pos + v[0].length]);
    if (!m[1].includes("\n")) pos += v[0].length;
  }
}
/* 第 4 條 → [text, masks]。兩組區間常常找到同一個值:標記字元再讀回標記段,線性地併起來 */
function maskKv(text) {
  const marked = new Uint8Array(text.length);
  for (const [s, e] of refSpans(text).concat(newSpans(text))) marked.fill(1, s, e);
  let out = "", pos = 0, masks = 0;
  for (let i = 0; i < text.length;) {
    if (!marked[i]) { i++; continue; }
    let j = i;
    while (j < text.length && marked[j]) j++;
    out += text.slice(pos, i) + MASK;
    pos = i = j;
    masks++;
  }
  return [out + text.slice(pos), masks];
}
const countOf = (text, v) => text.split(v).length - 1;

/* 第 6 條的網址／路徑 query(= api _query_sub):結果同 URL_QUERY_RE 再 PATH_QUERY_RE 兩次 replace,但線性。
   一段 query 不會跨空白或引號,所以每個 "?" 只在它那一串裡看一次:前一個 "?" 之後有沒有路徑起點 "/" */
const RUN_RE = new RegExp("[^" + WS + "\"']+", "gu");
const WS_CH_RE = new RegExp("^[" + WS + "\"'(=:]$", "u");
const pathStart = (text, i) => text[i] === "/" && (i === 0 || WS_CH_RE.test(text[i - 1]));
function querySub(text) {
  if (!text.includes("?")) return text;
  let out = "", pos = 0, run, nq = text.indexOf("?");
  const nextQ = (from) => { if (nq !== -1 && nq < from) nq = text.indexOf("?", from); return nq; };   // 起點只往前,整段只掃一次
  RUN_RE.lastIndex = 0;
  while ((run = RUN_RE.exec(text)) !== null) {
    let seg = run.index;
    const end = seg + run[0].length;
    let q = nextQ(seg);
    while (q !== -1 && q < end) {
      let hit = false;
      for (let i = seg; i < q && !hit; i++) hit = pathStart(text, i);
      if (hit) { out += text.slice(pos, q) + "?…"; pos = end; break; }
      seg = q + 1;
      q = nextQ(seg);
    }
  }
  return out + text.slice(pos);
}

/* 第 2–7 條,加上 known 給了時的第 1 條。回遮過的字,或整則排除時只回 EXCLUDED */
function redact(text, known) {
  if (typeof text !== "string" || !text) return "";
  if (text.length > INPUT_MAX) text = Array.from(text).slice(0, INPUT_MAX).join("");   // 只看(也只回)前 INPUT_MAX 個字
  if (PRIVATE_KEY_RE.test(text) || hasMnemonic(text)) return EXCLUDED;
  let masks = 0;
  const vals = [...new Set((known || []).filter((v) => typeof v === "string" && v))].sort((a, b) => cpLen(b) - cpLen(a));
  for (const v of vals) {
    const n = countOf(text, v);
    if (n) { masks += n; text = text.split(v).join(MASK); }
  }
  {
    const [t, n] = maskKv(text);
    text = t; masks += n;
  }
  text = text.replace(BEARER_RE, (m, head) => { masks++; return head + MASK; });
  text = text.replace(PREFIX_RE, () => { masks++; return MASK; });
  text = querySub(text.replace(HOME_RE, "~"));
  // 這組字元類含 "/":整串像路徑才按 "/" 切開各自判斷——每一段都像路徑字,而且串裡有 _ 或 -、或緊接在 . : ~ 後面
  // (github.com/…、~/…)、或後面跟著副檔名。base64 也帶 "/"、每段也可能像 camelCase,但這三樣都沒有;不然整串當一顆判斷。
  // regex 本體不動
  text = text.replace(LONG_TOKEN_RE, (m, at, str) => {
    const parts = m.split("/");
    EXT_RE.lastIndex = at + m.length;
    const pathlike = m.includes("_") || m.includes("-") || (at > 0 && ".:~".includes(str[at - 1])) || EXT_RE.test(str);
    if (!(pathlike && parts.every((seg) => !seg || wordish(seg)))) {
      if (!longTokenIsSecret(m)) return m;
      masks++;
      return MASK;
    }
    return parts.map((seg) => {
      if (seg.length >= LONG_TOKEN_MIN && longTokenIsSecret(seg)) { masks++; return MASK; }
      return seg;
    }).join("/");
  });
  return masks > MAX_MASKS ? EXCLUDED : text;
}

/* 第 1 條要比對的值:workspace/.env 裡鍵名像秘密、值 ≥ 6 字的,加上鍵名不像、但值本身就像金鑰(≥ 32 字、第 6 條那層過濾會遮)的。
   *_DEMO 這類旗標不收:交易所名、1 / true 會從每一則對話裡被抹掉。只回值,不回鍵名;讀不到檔回空清單 */
const ENV_SECRET_KEY_RE = /KEY|SECRET|PASSPHRASE|PASSWORD|TOKEN|ACCOUNT|PIN|PFX|CERT/i;
/* 設定值,不是秘密(ACCOUNT_TYPE=futures 這種):照 spec「*_DEMO=1 這類設定值不比對」的意思,值是這些字就不收,
   不然這個字會從每一則對話裡被抹掉。只認全小寫英文單字(大小寫混雜或帶數字的值照收) */
const ENV_STRICT_KEY_RE = /SECRET|PASSPHRASE|PASSWORD|PIN/i;
const ENV_SETTING_WORDS = new Set(["futures", "spot", "swap", "margin", "paper", "true", "false", "demo", "live",
  "testnet", "mainnet", "real", "cross", "isolated", "linear", "inverse", "unified", "classic", "hedge", "oneway", "yes", "no", "on", "off"]);
function envSecretValues(envText) {
  const out = [];
  if (typeof envText !== "string") return out;
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    // 設定字白名單只給 ACCOUNT／TYPE 這類鍵:鍵名本身就說是密碼、密語、PIN 的,值是 futures 也照遮
    if (/_DEMO$/i.test(key) || cpLen(val) < 6 || (ENV_SETTING_WORDS.has(val) && !ENV_STRICT_KEY_RE.test(key))) continue;
    const tokenish = new RegExp("^" + LONG_TOKEN_RE.source + "$").test(val) && val.split("/").some((s) => s.length >= LONG_TOKEN_MIN && longTokenIsSecret(s));
    if (ENV_SECRET_KEY_RE.test(key) || tokenish) out.push(val);
  }
  return out;
}

// _rule4 只給測試:聯集裡一組漏了另一組常常補得上,要各自驗
module.exports = { redact, envSecretValues, wordish, MASK, EXCLUDED, MAX_MASKS, WORDS_PATH, LONG_TOKEN_MIN, _rule4: { refSpans, newSpans } };
