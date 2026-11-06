/* 策略搬家(送上雲端／拉回這台電腦)的主行程那一半:讀本機策略檔組 strategy_import、收拉回的檔、寫暫存給本機 daemon。
   規格:blave-canon output/backend/strategy-transfer-desktop-spec-2026-11-05.md;機器端同一套規則在 runtime/strategy_transfer.py。
   - 名字、檔名、上限跟 runtime / api 同值(tests/check_transfer_parity.py 用同一批名字比對兩邊的判斷)。
   - 金鑰值只在這個行程:從 workspace .env 受管區塊照名字取,放進請求頂層 secrets;不回傳給 renderer、不 log。
   - 拉回的檔在這裡比兩份 sha256(ack 一份、暫存端點一份)才寫進 state/transfer_in/<id>/;daemon 讀完再驗一次就刪。
   這個檔不 require electron:測試直接 require。 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const ci = (w) => w.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
// = runtime strategy_transfer.WIN_RESERVED / api _WIN_RESERVED:Windows 建不出這些資料夾或檔案
const WIN_RESERVED = `(?!(?:${["con", "prn", "aux", "nul"].map(ci).join("|")}|${ci("com")}[0-9]|${ci("lpt")}[0-9])(?:\\.|$))`;
const NAME_RE = new RegExp(`^${WIN_RESERVED}[A-Za-z0-9_-]{1,64}$`);
const FILE_RE = new RegExp(`^${WIN_RESERVED}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\\.py$`);
const MAX_FILES = 20, FILE_MAX = 128 * 1024, TOTAL_MAX = 160 * 1024, ENV_MAX = 16;
const STAGE_DIR = path.join("state", "transfer_in");   // = runtime strategy_transfer.STAGE_DIR
const STAGE_ID_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const STAGE_STALE_MS = 3600 * 1000;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fail = (code, detail) => ({ error: code, detail: detail ? String(detail).slice(0, 120) : "" });

/* strategies/<name>/ 底下直接一層的一般 *.py(同 runtime collect_export:symlink 不跟、不帶;檔名不合規整個拒)。
   → { files:[{f, sha256, b64}] } 或 { error, detail }。 */
function collectLocal(ws, name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) return fail("BAD_ARGS");
  const dir = path.join(ws, "strategies", name);
  let entries;
  try {
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(path.join(dir, "strategy.py")).isFile()) return fail("NO_SOURCE");
    entries = fs.readdirSync(dir).sort();
  } catch (_) { return fail("NO_SOURCE"); }
  const files = [], bad = [];
  let total = 0;
  for (const f of entries) {
    if (!f.endsWith(".py")) continue;
    let st; try { st = fs.lstatSync(path.join(dir, f)); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (!FILE_RE.test(f)) { bad.push(f); continue; }
    const raw = fs.readFileSync(path.join(dir, f));
    total += raw.length;
    if (raw.length > FILE_MAX || total > TOTAL_MAX) return fail("TOO_LARGE", f);
    try { new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch (_) { return fail("NOT_UTF8", f); }
    files.push({ f, sha256: sha256(raw), b64: raw.toString("base64") });
  }
  if (bad.length) return fail("BAD_FILES", bad.slice(0, 3).join(", "));
  if (files.length > MAX_FILES) return fail("TOO_LARGE", `> ${MAX_FILES} files`);
  return { files };
}

/* 這支策略用到的資料來源(sources:來源名)在 .env 受管區塊裡的值 → { secrets: {DATA_X_Y: 值}, missing: [來源] }。
   parse 由呼叫端給(datasrc.parse);交易所形狀的名字(venueShaped)與過不了 cleanValue 的值不送:機器端本來就會拒。 */
function dataSecrets(envText, sources, ds) {
  const doc = ds.parse(envText), secrets = {}, missing = [];
  for (const src of sources) {
    const s = doc.sources.get(src);
    if (!s || !s.fields.size) { missing.push(src); continue; }
    for (const [field, line] of s.fields) {
      const name = ds.envName(src, field), m = /^[^=]+='(.*)'$/.exec(line) || /^[^=]+=(.*)$/.exec(line);
      const v = m ? ds.cleanValue(m[1]) : null;
      if (v && !ds.venueShaped(name) && Object.keys(secrets).length < ENV_MAX) secrets[name] = v;
    }
  }
  return { secrets, missing };
}

/* 拉回:ack 的 {name, files:[{f, sha256}]} 對上暫存端點的 {status:"done", name, files:[{f, sha256, b64}]}。
   兩份的檔名集合、每個 sha256 都要一致,而且解出來的 bytes 也要對得上 → { files:[{f, raw}] } 或 { error }。 */
function checkExport(name, ack, got) {
  if (!ack || !Array.isArray(ack.files) || !got || got.status !== "done" || got.name !== name || !Array.isArray(got.files)) return fail("BAD_FILES");
  if (!ack.files.length || ack.files.length > MAX_FILES || ack.files.length !== got.files.length) return fail("BAD_FILES");
  const want = new Map();
  for (const x of ack.files) {
    if (!x || typeof x.f !== "string" || !FILE_RE.test(x.f) || !SHA_RE.test(String(x.sha256)) || want.has(x.f.toLowerCase())) return fail("BAD_FILES");
    want.set(x.f.toLowerCase(), x);
  }
  if (!want.has("strategy.py")) return fail("BAD_FILES");
  const out = [];
  let total = 0;
  for (const x of got.files) {
    const a = x && typeof x.f === "string" ? want.get(x.f.toLowerCase()) : null;
    if (!a || a.f !== x.f || a.sha256 !== x.sha256 || typeof x.b64 !== "string") return fail("BAD_FILES", x && x.f);
    const raw = Buffer.from(x.b64, "base64");
    total += raw.length;
    if (raw.length > FILE_MAX || total > TOTAL_MAX) return fail("TOO_LARGE", x.f);
    if (sha256(raw) !== a.sha256) return fail("BAD_FILES", x.f);
    out.push({ f: x.f, raw });
  }
  return { files: out };
}

/* 寫到 <ws>/state/transfer_in/<id>/ 給本機 daemon(它讀完就刪)。順手清掉一小時前留下的暫存(daemon 沒起來、送失敗)。
   每個檔 wx 建立:資料夾是新建的,同名 symlink 不可能先在。→ [{f, sha256}] */
function stage(ws, id, files, now) {
  if (!STAGE_ID_RE.test(id)) throw new Error("BAD_STAGE");
  const root = path.join(ws, STAGE_DIR);
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("BAD_STAGE");
  const t = now || Date.now();
  for (const old of fs.readdirSync(root)) {
    const p = path.join(root, old);
    try { if (STAGE_ID_RE.test(old) && t - fs.lstatSync(p).mtimeMs > STAGE_STALE_MS) fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* 下次再清 */ }
  }
  const dir = path.join(root, id);
  fs.mkdirSync(dir);   // 已經在 = 同一個 id 送過兩次:讓它丟,不覆蓋
  try {
    for (const x of files) fs.writeFileSync(path.join(dir, x.f), x.raw, { flag: "wx", mode: 0o600 });
  } catch (e) { unstage(ws, id); throw e; }
  return files.map((x) => ({ f: x.f, sha256: sha256(x.raw) }));
}
function unstage(ws, id) {
  if (!STAGE_ID_RE.test(String(id))) return;
  const p = path.join(ws, STAGE_DIR, id);
  try { if (!fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* 已經不在 */ }
}

const RUN_ACK_MS = 60000;   // import 在機器上驗完、寫完才 ack(背景跑不等);export 要先把檔交給 api
const FETCH_TRIES = 10, FETCH_GAP_MS = 1500;

/* 送上雲端。deps = { ws, readEnv() → .env 全文, sources(name) → [來源名], ds(datasrc 模組), send(cmd, args, secrets, opts) }。
   requestId:重試時傳回上一趟的那顆(換一顆 = 機器多開一支 <name>_N+1)。
   回 send 的形狀再加 missing(這台電腦沒有金鑰的來源);讀檔就失敗 → { ok:false, error, detail, kind:"local" }。 */
async function up(deps, name, to, requestId) {
  if (!NAME_RE.test(String(name)) || (to != null && !NAME_RE.test(String(to)))) return { ok: false, error: "BAD_ARGS", kind: "local" };
  const c = collectLocal(deps.ws, name);
  if (c.error) return { ok: false, error: c.error, detail: c.detail, kind: "local" };
  let envText = "";
  try { envText = deps.readEnv(); } catch (_) { /* 沒有 .env = 沒有金鑰,照搬程式碼 */ }
  const { secrets, missing } = dataSecrets(envText, deps.sources(name), deps.ds);
  const args = { name, files: c.files };
  if (to && to !== name) args.to = to;
  const r = await deps.send("strategy_import", args, Object.keys(secrets).length ? secrets : null, { requestId, ackWindowMs: RUN_ACK_MS });
  return Object.assign({}, r, { missing });
}

/* 拉回這台電腦。deps = { ws, send(同上), fetchExport(id) → 暫存端點的回應 body, daemonSend(args) → 本機 strategy_import 的 {ok, result|error}, sleep(ms) }。
   金鑰不搬(第一版)。回 { ok:true, result:<本機 import 的 ack>, exported:{type, left_behind} } 或 { ok:false, error, kind, detail? }。 */
async function down(deps, name, to) {
  if (!NAME_RE.test(String(name)) || (to != null && !NAME_RE.test(String(to)))) return { ok: false, error: "BAD_ARGS", kind: "local" };
  const r = await deps.send("strategy_export", { name }, null, { ackWindowMs: RUN_ACK_MS });
  if (!r.ok) return r;
  let got = null;
  for (let i = 0; i < FETCH_TRIES; i++) {
    try { got = await deps.fetchExport(r.id); } catch (_) { got = null; }
    if (got && got.status === "done") break;
    await deps.sleep(FETCH_GAP_MS);
  }
  if (!got || got.status !== "done") return { ok: false, error: "HANDOVER", kind: "rejected" };
  const chk = checkExport(name, r.result, got);
  if (chk.error) return { ok: false, error: chk.error, detail: chk.detail, kind: "rejected" };
  const sid = crypto.randomBytes(16).toString("hex");
  let staged;
  try { staged = stage(deps.ws, sid, chk.files); } catch (_) { return { ok: false, error: "WRITE_FAILED", kind: "local" }; }
  const args = { name, stage: sid, files: staged };
  if (to && to !== name) args.to = to;
  const d = await deps.daemonSend(args);
  unstage(deps.ws, sid);   // daemon 讀完就自己刪;沒送到時這裡收
  const exported = { type: r.result && r.result.type, left_behind: Array.isArray(r.result && r.result.left_behind) ? r.result.left_behind.slice(0, 50) : [] };
  return d.ok ? { ok: true, result: d.result, exported } : { ok: false, error: String(d.error || "FAILED"), kind: "rejected", exported };
}

module.exports = { up, down, NAME_RE, FILE_RE, WIN_RESERVED, MAX_FILES, FILE_MAX, TOTAL_MAX, STAGE_DIR, collectLocal, dataSecrets, checkExport, stage, unstage };
