/* 錯誤回報(spec agent-error-report-2026-11-16;問過用戶才送)。主行程用,純模組、不依賴 Electron;tests/check_shell_errreport.js
   記錄檔 <workspace>/state/error_reports.jsonl:lib/error_report.py(py_lib)與主行程 uncaughtExceptionMonitor(shell_main)只 append,
   截斷與清檔只有這裡做。檔在 agent 與用戶策略寫得到的地方,內容不可信:逐行照 api 同一套白名單重驗、不合就丟,
   lib／manager 的 frame 跟官方檔 manifest 對不上、runtime／shell 的 frame 在隨包裡找不到,都換成 <other>,換完沒有自家 frame 的整筆丟。
   message 在這裡清洗一次(redact.js 帶 .env 已知值 + 五條,api openclaw/desktop_error_report.py 同一份 fixture),
   卡上顯示的 JSON 與送出的 body 是同一個物件:送出時只多 token(不顯示)與 consent(按下去才有值)。
   自動送(consent: always)從白名單重新組、沒有 message 這個 key。 */
"use strict";
const crypto = require("crypto");
const path = require("path");
const R = require("./redact");
const wsfile = require("./wsfile");

const MESSAGE_MAX = 300, RAW_MESSAGE_MAX = 2000, FRAMES_MAX = 30, FP_FRAMES = 5, OTHER = "<other>", SEP = "\x1f";
const MAX_FILE_BYTES = 256 * 1024, MAX_LINES = 200, MAX_LINE_BYTES = 8192, READ_MAX = 512 * 1024;
const DECLINE_MS = 30 * 86400000;
const MODES = ["ask", "auto", "off"];
const SOURCES = ["py_lib", "shell_main"];
// 同 api 的白名單(JS 的 $ 沒有 m 旗標時不放過結尾換行,等同 Python 的 \Z)
const EXC_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,79}$/;
const FILE_RE = /^(lib|runtime|manager|shell)\/[A-Za-z0-9_./-]{1,80}$/;
const FUNC_RE = /^[A-Za-z_<>$.][A-Za-z0-9_<>$.]{0,59}$/;
const PY_VERSION_RE = /^3\.[0-9]{1,2}(\.[0-9]{1,3})?$/;
const SID_RE = /^desktop-[a-z0-9]{4,16}$/;   // 對話 id(同 main.js 的格式檢查):lib/error_report.py 記的是哪條對話,只在本機、不送

// ── message 清洗:redact() 之後的五條,順序與寫法同 api desktop_error_report.py(數字一律 [0-9]) ──
const ID_RE = /(?:TW)?[A-Z][A-D1289][0-9]{8}1?|[A-Z][0-9]{9}/g;
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const IPV4_RE = /(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9]|\.[0-9])/g;
const H = "[0-9A-Fa-f]{1,4}";
const IPV6_RE = new RegExp(`(?<![0-9A-Za-z:.])(?:(?:${H}:){7}${H}|${H}(?::${H}){0,6}::(?:${H}(?::${H}){0,6})?|::${H}(?::${H}){0,6})(?![0-9A-Za-z:])`, "g");
const TOKEN_RE = /(?<![A-Za-z0-9+=])[A-Za-z0-9+=]{20,}(?![A-Za-z0-9+=])/g;

function dropDicts(text) {
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const start = text.indexOf("{", i);
    if (start < 0) { out += text.slice(i); break; }
    out += text.slice(i, start) + "{…}";
    let depth = 0, j = start;
    for (; j < n; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}
const cut = (s, n) => Array.from(s).slice(0, n).join("");   // 照 code point 截,同 Python 的 [:n]
function scrub(text, known) {
  let t = R.redact(typeof text === "string" ? text : "", known || []);
  t = dropDicts(t).replace(ID_RE, "[id]").replace(EMAIL_RE, "[email]").replace(IPV4_RE, "[ip]").replace(IPV6_RE, "[ip]")
    .replace(TOKEN_RE, (s) => (/[A-Za-z]/.test(s) && /[0-9]/.test(s) ? "[redacted]" : s));
  return cut(t, MESSAGE_MAX);
}
function fingerprint(source, excType, frames) {
  const own = frames.filter((f) => f.file !== OTHER).slice(0, FP_FRAMES).map((f) => `${f.file}:${f.func}`);
  return crypto.createHash("sha1").update([source, excType, ...own].join(SEP), "utf8").digest("hex");
}

function cleanFrames(raw) {
  if (!Array.isArray(raw) || raw.length > FRAMES_MAX) return null;
  const out = [];
  for (const f of raw) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    const keys = Object.keys(f).sort().join(",");
    if (f.file === OTHER) { if (keys !== "file") return null; out.push({ file: OTHER }); continue; }
    if (keys !== "file,func,line") return null;
    if (typeof f.file !== "string" || !FILE_RE.test(f.file) || f.file.split("/").includes("..")) return null;
    if (typeof f.func !== "string" || !FUNC_RE.test(f.func)) return null;
    if (!Number.isInteger(f.line) || f.line <= 0 || f.line > 1e7) return null;
    out.push({ file: f.file, func: f.func, line: f.line });
  }
  return out;
}
/* 一行 → 記錄(白名單重組)或 null */
function parseLine(raw) {
  let o;
  try { o = JSON.parse(raw); } catch (_) { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (!SOURCES.includes(o.source) || typeof o.exc_type !== "string" || !EXC_TYPE_RE.test(o.exc_type)) return null;
  if (typeof o.message !== "string" || Array.from(o.message).length > RAW_MESSAGE_MAX) return null;
  const frames = cleanFrames(o.frames);
  if (!frames) return null;
  const py = o.py_version;
  if (o.source === "py_lib" ? !(typeof py === "string" && PY_VERSION_RE.test(py)) : py !== undefined) return null;
  if (o.sid !== undefined && !(typeof o.sid === "string" && SID_RE.test(o.sid))) return null;
  return { ts: Number.isFinite(o.ts) ? o.ts : 0, source: o.source, exc_type: o.exc_type, message: o.message, frames,
    ...(o.source === "py_lib" ? { py_version: py } : {}), ...(o.sid ? { sid: o.sid } : {}) };
}
/* lib／manager 對官方 manifest、runtime／shell 對隨包;對不上換 <other>,連續的 <other> 併一格。
   最內層那格自家 frame(寫入端據以判定「是我們的」那一格)對不上 → null:那是 agent 加或改過的檔,等同用戶的 code(spec §3.1) */
function vetFrames(frames, isOfficial, isBundled) {
  const out = [];
  let first = true;
  for (const f of frames) {
    let keep = f.file !== OTHER;
    if (keep) { const top = f.file.split("/")[0]; try { keep = top === "lib" || top === "manager" ? !!isOfficial(f.file) : !!isBundled(f.file); } catch (_) { keep = false; } }
    if (f.file !== OTHER && first) { if (!keep) return null; first = false; }
    if (keep) out.push(f);
    else if (!out.length || out[out.length - 1].file !== OTHER) out.push({ file: OTHER });
  }
  return first ? null : out;
}

/* 主行程未接的例外 → 一行(或 null)。shellDir = 這支檔所在的 shell/(打包版在 app.asar 裡)。
   只認主行程 stack 的第一格不是 node 內部或套件的那一格在 shell/ 裡;網路類與不是 Error 的 rejection 不記 */
const NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ECONNABORTED", "ESOCKETTIMEDOUT"]);
const STACK_RE = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/;
function jsFunc(name) {
  let f = String(name || "").replace(/^(async|new) /, "").split(" ")[0];
  return FUNC_RE.test(f) ? f : "<anonymous>";
}
function mainRecord(err, shellDir, now) {
  if (!(err instanceof Error) || typeof err.stack !== "string") return null;
  if (NET_CODES.has(err.code) || err.name === "AbortError" || err.name === "TimeoutError" || /^net::/.test(String(err.message))) return null;
  const name = (err.constructor && err.constructor.name) || err.name;
  const excType = EXC_TYPE_RE.test(name || "") ? name : "Error";
  const frames = [];
  let first;
  for (const line of err.stack.split("\n")) {
    const m = STACK_RE.exec(line);
    if (!m) continue;
    let file = m[2].replace(/^file:\/\//, "");
    let rel = null;
    if (path.isAbsolute(file)) { const r = path.relative(shellDir, file); if (r && !r.startsWith("..") && !path.isAbsolute(r) && !r.split(path.sep).includes("node_modules")) rel = "shell/" + r.split(path.sep).join("/"); }
    const ours = rel && FILE_RE.test(rel) ? rel : null;
    if (first === undefined && ours) first = ours;   // 主行程沒有用戶的 code:不是 shell/ 的都當套件
    if (ours) frames.push({ file: ours, func: cut(jsFunc(m[1]), 60), line: Number(m[3]) || 1 });
    else if (!frames.length || frames[frames.length - 1].file !== OTHER) frames.push({ file: OTHER });
  }
  if (!first) return null;
  const rec = { v: 1, ts: now, source: "shell_main", exc_type: excType, message: cut(String(err.message || ""), RAW_MESSAGE_MAX), frames: frames.slice(0, FRAMES_MAX) };
  let line = JSON.stringify(rec) + "\n";
  while (Buffer.byteLength(line) > MAX_LINE_BYTES && rec.message) { rec.message = cut(rec.message, Math.floor(Array.from(rec.message).length / 2)); line = JSON.stringify(rec) + "\n"; }
  return Buffer.byteLength(line) <= MAX_LINE_BYTES ? line : null;
}

/* o:{ fs?, file, stateFile, endpoint, now?(), known?() → [已知值], isOfficial(rel), isBundled(rel), meta() → { install_id, app_version,
   runtime_version, os, os_version } | null, token?() → 帳號 token | null, post(url, body) → Promise, live?() → 開發版 false = 不發請求 } */
function createErrReport(o) {
  const fs = o.fs || require("fs");
  const now = o.now || Date.now;
  const NOFOLLOW = (fs.constants && fs.constants.O_NOFOLLOW) || 0;
  let st = null, cur = null;

  const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  // 壞檔 = 每次問我(「自動送」不能因為壞檔就冒出來)
  function load() {
    if (st) return st;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(o.stateFile, "utf8")); } catch (_) { raw = null; }
    const ok = raw && typeof raw === "object";
    const declined = {};
    if (ok && raw.declined && typeof raw.declined === "object") for (const [k, v] of Object.entries(raw.declined)) if (/^[0-9a-f]{40}$/.test(k) && Number.isFinite(v)) declined[k] = v;
    st = { mode: ok && MODES.includes(raw.mode) ? raw.mode : "ask", asked: ok && typeof raw.asked === "string" ? raw.asked : null, declined };
    return st;
  }
  function save() {
    try { const tmp = o.stateFile + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 }); fs.renameSync(tmp, o.stateFile); } catch (_) { /* 記不住:最壞是多問一次 */ }
  }
  // 記錄檔是 symlink 就只拿掉那個連結(不跟過去讀寫);不是一般檔當沒有
  function plainFile() {
    let s;
    try { s = fs.lstatSync(o.file); } catch (_) { return false; }
    if (s.isSymbolicLink()) { try { fs.unlinkSync(o.file); } catch (_) { /* noop */ } return false; }
    return s.isFile();
  }
  function readLines() {
    if (!plainFile()) return [];
    let text = "";
    try {
      const fd = fs.openSync(o.file, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, READ_MAX), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        text = buf.toString("utf8");
        if (size > len) text = text.slice(text.indexOf("\n") + 1);   // 從檔中間讀起:第一行是半截
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
    let lines = text.split("\n").filter((l) => l.trim());
    if (lines.length > MAX_LINES) { lines = lines.slice(-MAX_LINES); rewrite(lines); }
    return lines;
  }
  // 寫檔永遠不拋(Windows 上 rename 可能失敗:那次就不截)。暫存檔走 wsfile:固定的 .tmp 名 agent 能先放成 symlink,
  // 沒有沙箱的主行程會照著寫到工作區外(稽核 0156 S-1)
  function rewrite(lines) {
    try {
      if (!lines.length) { if (plainFile()) fs.unlinkSync(o.file); return; }
      wsfile.replace(o.file, lines.join("\n") + "\n");
    } catch (_) { /* 這次不截 */ }
  }
  // 拿掉處理過的那幾行(照原字串比,同一行出現幾次拿幾次)。讀完到 rename 之間 Python 那端 append 的行會跟舊檔一起不見:
  // 最多少記一筆錯誤、不會壞檔,不為這個在兩個行程間加鎖(稽核 0156 B-1)
  function consume(raws) {
    if (!raws.length) return;
    const left = new Map();
    for (const r of raws) left.set(r, (left.get(r) || 0) + 1);
    const keep = readLines().filter((l) => { const n = left.get(l) || 0; if (n) { left.set(l, n - 1); return false; } return true; });
    rewrite(keep);
  }

  function views(lines, consent) {
    const meta = o.meta && o.meta();
    if (!meta) return null;
    const known = (o.known && o.known()) || [];
    const cache = new Map(), memo = (fn) => (rel) => { const k = fn === o.isOfficial ? "o:" + rel : "b:" + rel; if (!cache.has(k)) cache.set(k, fn(rel)); return cache.get(k); };
    const isOff = memo(o.isOfficial), isBun = memo(o.isBundled);
    const groups = new Map(), bad = [];
    for (const raw of lines) {
      const rec = parseLine(raw), frames = rec && vetFrames(rec.frames, isOff, isBun);
      if (!frames) { bad.push(raw); continue; }
      const fp = fingerprint(rec.source, rec.exc_type, frames);
      const g = groups.get(fp);
      if (!g) groups.set(fp, { fp, rec, frames, raws: [raw] });
      else { g.raws.push(raw); if (rec.ts >= g.rec.ts) { g.rec = rec; g.frames = frames; } }
    }
    const out = [...groups.values()].map((g) => {
      const r = g.rec, v = { install_id: meta.install_id, source: r.source, exc_type: r.exc_type };
      if (consent === "once") v.message = scrub(r.message, known);
      Object.assign(v, { frames: g.frames, app_version: meta.app_version, runtime_version: meta.runtime_version, os: meta.os, os_version: meta.os_version });
      if (r.py_version) v.py_version = r.py_version;
      return { fp: g.fp, raws: g.raws, view: v };
    });
    return { items: out, bad };
  }
  function body(view, consent) {
    const tok = o.token && o.token();
    const { install_id, ...rest } = view;
    return { install_id, ...(typeof tok === "string" && tok ? { token: tok } : {}), consent, ...rest };
  }
  function send(items, consent) {
    if (o.live && !o.live()) return Promise.resolve([]);
    return Promise.allSettled(items.map((it) => o.post(o.endpoint, body(it.view, consent))));   // 429 / 送不出去:丟掉,不重試
  }

  /* 卡只問出事的那條對話、那一輪剛結束時(0.1.59:前一天別條對話的錯出現在新對話裡)。
     scope = { sid, since, running: Map(sid → 那一輪開跑時間) }:sid 那一輪剛結束,只問它 since 之後記的;
     沒有 sid = 剛開 app,只問不屬於任何對話的(主行程、背景程式)。
     屬於某條對話、但那條沒在跑或記在它這一輪開跑之前的:再也輪不到它的卡,直接丟。自動送不分,照舊全送 */
  function scoped(lines, scope) {
    const run = (scope && scope.running) || new Map(), sid = scope && scope.sid, use = [], stale = [];
    for (const raw of lines) {
      const r = parseLine(raw);
      if (!r) use.push(raw);   // 壞行交給 views 丟
      else if (!r.sid) { if (!sid) use.push(raw); }
      else if (sid && r.sid === sid && r.ts >= scope.since) use.push(raw);
      else if (!(run.has(r.sid) && r.ts >= run.get(r.sid))) stale.push(raw);
    }
    return { use, stale };
  }
  /* 回合結束(scope)、或剛開 app:有新記錄而且今天還沒出過卡 → { id, n, text }(text = 卡上〔看內容〕顯示的那一份);其餘 null。
     自動送在這裡背景送掉;不送 = 清檔 */
  function pending(scope) {
    const s = load();
    if (s.mode === "off") { rewrite([]); cur = null; return null; }
    const lines = readLines();
    if (!lines.length) return null;
    const t = now();
    for (const [k, v] of Object.entries(s.declined)) if (t - v > DECLINE_MS) delete s.declined[k];
    const sid = scope && scope.sid;
    const { use, stale } = s.mode === "auto" ? { use: lines, stale: [] } : scoped(lines, scope);
    const v = views(use, s.mode === "auto" ? "always" : "once");
    if (!v) return null;
    let items = v.items, done = v.bad.concat(stale);
    if (s.mode === "auto") {
      send(items, "always");
      consume(done.concat(...items.map((it) => it.raws)));
      return null;
    }
    const quiet = items.filter((it) => s.declined[it.fp]);
    done = done.concat(...quiet.map((it) => it.raws));
    items = items.filter((it) => !s.declined[it.fp]);
    if (!items.length || s.asked === localDay(t)) {
      consume(sid ? done.concat(...items.map((it) => it.raws)) : done);   // 這一輪今天問不了:之後也不該在別處冒出來
      save(); return null;
    }
    consume(done);
    s.asked = localDay(t); save();
    cur = { id: crypto.randomBytes(8).toString("hex"), items };
    return { id: cur.id, n: items.length, text: shownText(items.map((it) => it.view)) };
  }
  /* action:send | decline;always = 勾了以後自動送(只在 send 有用)。這一批看過的照 once 帶 message 送 */
  async function decide(id, action, always) {
    if (!cur || cur.id !== id || (action !== "send" && action !== "decline")) return false;
    const b = cur, s = load();
    cur = null;
    if (action === "send" && s.mode !== "off") {
      if (always === true) s.mode = "auto";
      await send(b.items, "once");
    } else if (action === "decline") for (const it of b.items) s.declined[it.fp] = now();
    save();
    consume([].concat(...b.items.map((it) => it.raws)));
    return true;
  }
  function setMode(m) {
    if (!MODES.includes(m)) return load().mode;
    load().mode = m; save();
    if (m === "off") { cur = null; rewrite([]); }
    return m;
  }
  /* 主行程未接例外:同步寫一行(行程可能馬上就結束)。永遠不拋 */
  function appendMain(err, shellDir) {
    try {
      if (load().mode === "off") return false;
      const line = mainRecord(err, shellDir, now());
      if (!line) return false;
      try { const s = fs.lstatSync(o.file); if (s.isSymbolicLink() || s.size > MAX_FILE_BYTES) return false; } catch (_) { /* 還沒有檔 */ }
      if (!fs.existsSync(path.dirname(o.file))) return false;   // 工作區還沒建:不寫
      const fd = fs.openSync(o.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
      try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
      return true;
    } catch (_) { return false; }
  }
  return { pending, decide, mode: () => load().mode, setMode, appendMain, _body: body };
}
const shownText = (list) => JSON.stringify(list, null, 2);

module.exports = { createErrReport, scrub, fingerprint, parseLine, vetFrames, mainRecord, shownText, dropDicts,
  MESSAGE_MAX, FRAMES_MAX, MAX_FILE_BYTES, MAX_LINES, OTHER, MODES };
