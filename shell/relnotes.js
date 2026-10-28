/* 更新 modal 的「這版改了什麼」(spec desktop-update-pill §4.3):GitHub Release 的說明 → 每語最多 3 條純文字。
   拿不到就是沒有(回 null),不重試、不擋重開。不依賴 electron:node 測試直接跑。 */
const https = require("https");

const VER_RE = /^\d+\.\d+\.\d+$/;
const MAX_BYTES = 256 * 1024, TIMEOUT_MS = 5000, MAX_ITEMS = 3, ZH_CHARS = 40, EN_WORDS = 25;
// 控制字元、零寬字元、bidi 嵌入／覆寫／隔離(U+200B–U+200F、U+2028–U+202E、U+2060–U+2069、U+FEFF)與反引號:說明是別人寫的字,畫面只收看得見、方向不會被翻的字。
// U+2010–U+2027 是一般標點(— … ’ “),照留
const STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff`]/g;

function clip(s, lang) {
  if (lang === "zh") { const a = Array.from(s); return a.length > ZH_CHARS ? a.slice(0, ZH_CHARS).join("") + "…" : s; }
  const w = s.split(/\s+/);
  return w.length > EN_WORDS ? w.slice(0, EN_WORDS).join(" ") + "…" : s;
}
/* body:Release 說明原文。版面(app-release.md):zh 段、一行 `---`、en 段。沒有 `---` 就分不出語言 → 兩邊都空 */
function parseNotes(body) {
  const out = { zh: [], en: [] };
  if (typeof body !== "string") return out;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const cut = lines.findIndex((l) => l.trim() === "---");
  if (cut < 0) return out;
  const pick = (part, lang) => part.filter((l) => l.startsWith("- ")).slice(0, MAX_ITEMS)
    .map((l) => clip(l.slice(2).replace(STRIP_RE, "").replace(/\s+/g, " ").trim(), lang)).filter(Boolean);
  out.zh = pick(lines.slice(0, cut), "zh");
  out.en = pick(lines.slice(cut + 1), "en");
  return out;
}
/* v = 已暫存的版號。回 { v, zh, en } 或 null。o.get 給測試換掉 https.get */
function fetchNotes(v, o) {
  const opt = o || {}, get = opt.get || https.get;
  if (typeof v !== "string" || !VER_RE.test(v)) return Promise.resolve(null);
  const tag = "desktop-v" + v;
  return new Promise((resolve) => {
    let done = false, req = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); if (req) try { req.destroy(); } catch (_) { /* 已結束 */ } resolve(r); };
    const timer = setTimeout(() => finish(null), opt.timeoutMs || TIMEOUT_MS);
    try {
      req = get("https://api.github.com/repos/Blave-TW/blave-agent/releases/tags/" + tag,
        { headers: { "User-Agent": "Blave-Desktop", Accept: "application/vnd.github+json" } }, (res) => {
          if (res.statusCode !== 200) { res.resume(); finish(null); return; }
          const parts = []; let n = 0;
          res.on("data", (d) => { n += d.length; if (n > MAX_BYTES) { finish(null); return; } parts.push(d); });
          res.on("end", () => {
            if (done) return;
            let j = null; try { j = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch (_) { finish(null); return; }
            if (!j || j.tag_name !== tag) { finish(null); return; }
            const p = parseNotes(j.body);
            finish(p.zh.length || p.en.length ? { v, zh: p.zh, en: p.en } : null);
          });
          res.on("error", () => finish(null));
        });
      req.on("error", () => finish(null));
    } catch (_) { finish(null); }
  });
}
module.exports = { parseNotes, fetchNotes, VER_RE };
