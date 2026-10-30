/* 對話文字離開這台電腦之前的遮蔽(spec mobile-agent-chat-mvp §4.3;主行程用)。
 *
 * 規則與順序逐條照 api openclaw/redact.py;兩邊跑同一份 tests/fixtures/redact_cases.json(逐字比對兩份檔,
 * tests/check_shell_redact.js)。改一條規則就兩邊與 fixture 一起改。
 * 第 1 條(已知的值)只有這裡有:值由呼叫端交進來,只在記憶體比對,不寫檔、不 log、不回傳。
 * 第 6 條的四個 regex 直接用 mobileview.js 那組物件(與 api desktop_portfolio 逐字比對過),本體不動。
 * 盡力遮,不保證認得出每一種秘密。
 */
const fs = require("fs");
const path = require("path");
const { HOME_RE, URL_QUERY_RE, PATH_QUERY_RE, LONG_TOKEN_RE } = require("./mobileview");

const MASK = "⟦R⟧";
const EXCLUDED = "⟦R:msg⟧";
const MAX_MASKS = 5;
const MNEMONIC_MIN_WORDS = 12;
const LONG_TOKEN_MIN = 32;   // = LONG_TOKEN_RE 的 {32,}

// Python str 的 \s(str.isspace)跟 JS 的 \s 差三組字元(\x1c-\x1f、\x85 / ﻿):自己寫的這幾條照 Python 那一組
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const NUMBERING_RE = /^[0-9]+[.)]?$/;
const WORD_EDGE = ".,;:!?\"'()[]{}";
const WORD_SPLIT_RE = new RegExp("[" + WS + "\"',\\[\\]{}\\-]+", "u");
/* 名=值(api 複稽核 N1 後的寫法):只掃「名字段」,名字含關鍵字才吃它後面的值;不含就只前進到名字結尾——
   值裡面可能還有下一對 key=value。名字段的 lookbehind 只讓比對從一串名字字元的開頭起跑,整段線性。
   u 旗標:{6,} 跟 Python 一樣按字(code point)數 */
const KV_NAME_PART_RE = new RegExp("(?<![A-Za-z0-9_.\\-])[A-Za-z0-9_.\\-]+[\"']?[" + WS + "]*[:=][" + WS + "]*[\"']?", "gu");
const KV_VALUE_RE = new RegExp("[^" + WS + "\"'`,;&]{6,}", "yu");
const KV_NAME_RE = /key|secret|token|passphrase|password|passwd|pwd|private/i;
const PREFIX_RE = new RegExp(
  "(?<![A-Za-z0-9_\\-.])eyJ[A-Za-z0-9_\\-]+\\.eyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+"
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
    if (words.has(stripEdge(tok).toLowerCase())) { if (++run >= MNEMONIC_MIN_WORDS) return true; }
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

/* 像路徑字的一段:小寫起頭的 camelCase／帶數字、全大寫帶數字、大寫起頭的字、純數字,用 _ . - 串起來。
   = api 原型的 _WORDISH_RE,但每一段連續的小寫／數字都吃到底(lookahead),不回溯——原型那條在「a + 一串數字 + =」上是指數級 */
const L = "[a-z]+(?![a-z])", D = "[0-9]+(?![0-9])";
const TAIL = "(?:[A-Z]" + L + "|[A-Z]?" + D + ")*";
const UNIT = "(?:" + L + TAIL + "[A-Z]?(?![a-z0-9])|[A-Z]+(?![A-Z])[0-9]*(?![0-9])|[A-Z]" + L + TAIL + "|" + D + ")";
const WORDISH_RE = new RegExp("^" + UNIT + "(?:[_.\\-]" + UNIT + ")*$");
const wordish = (seg) => WORDISH_RE.test(seg);
const cpLen = (s) => Array.from(s).length;
const countOf = (text, v) => text.split(v).length - 1;

/* 第 2–7 條,加上 known 給了時的第 1 條。回遮過的字,或整則排除時只回 EXCLUDED */
function redact(text, known) {
  if (typeof text !== "string" || !text) return "";
  if (PRIVATE_KEY_RE.test(text) || hasMnemonic(text)) return EXCLUDED;
  let masks = 0;
  const vals = [...new Set((known || []).filter((v) => typeof v === "string" && v))].sort((a, b) => cpLen(b) - cpLen(a));
  for (const v of vals) {
    const n = countOf(text, v);
    if (n) { masks += n; text = text.split(v).join(MASK); }
  }
  {
    let out = "", pos = 0, m;
    KV_NAME_PART_RE.lastIndex = 0;
    while ((m = KV_NAME_PART_RE.exec(text)) !== null) {
      const end = m.index + m[0].length;
      let v = null;
      if (KV_NAME_RE.test(m[0])) { KV_VALUE_RE.lastIndex = end; v = KV_VALUE_RE.exec(text); }
      if (!v) { out += text.slice(pos, end); pos = end; continue; }
      masks++;
      out += text.slice(pos, end) + MASK; pos = end + v[0].length;
      KV_NAME_PART_RE.lastIndex = pos;
    }
    text = out + text.slice(pos);
  }
  text = text.replace(PREFIX_RE, () => { masks++; return MASK; });
  text = text.replace(HOME_RE, "~").replace(URL_QUERY_RE, "$1?…").replace(PATH_QUERY_RE, "$1$2?…");
  // 這組字元類含 "/":每一段都像路徑字(策略名、網址的一段)才按 "/" 切開各自判斷;不然整串當一顆判斷——
  // base64 金鑰本身就可能帶 "/"(api 複稽核 N2)。regex 本體不動
  text = text.replace(LONG_TOKEN_RE, (m) => {
    const parts = m.split("/");
    if (!parts.every((seg) => !seg || wordish(seg))) {
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
    if (/_DEMO$/i.test(key) || cpLen(val) < 6) continue;
    const tokenish = new RegExp("^" + LONG_TOKEN_RE.source + "$").test(val) && val.split("/").some((s) => s.length >= LONG_TOKEN_MIN && longTokenIsSecret(s));
    if (ENV_SECRET_KEY_RE.test(key) || tokenish) out.push(val);
  }
  return out;
}

module.exports = { redact, envSecretValues, wordish, MASK, EXCLUDED, MAX_MASKS, WORDS_PATH, LONG_TOKEN_MIN };
