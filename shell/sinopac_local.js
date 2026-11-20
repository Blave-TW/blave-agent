/* 永豐期貨 本機開通(電腦版 Mac／Windows)— 主行程這一側。畫面在 renderer/sinopac.js;機器端在 runtime/sinopac_local.py。
   設計 spec sinopac-connect-2026-11-17(Wei 11-17:身分證一格兼憑證密碼、加密存放、說明照實寫「不放在 agent 的設定檔」)。
   - API Key、Secret、身分證字號、憑證密碼:safeStorage 加密存在 userData 的 sinopac.bin,只有這個行程解得開(同統一 president.bin)。
     要用時封裝成 sinopac_local 指令交給 daemon:AES-GCM,金鑰由 daemon 的 HMAC secret 衍生(info／AAD 跟統一、群益不同,
     那兩家的密文在這裡打不開)。daemon 只放在記憶體、經 stdin 交給下單程式;機器的 .env 只有哨兵。renderer 送進來一次、拿不回去;不 log、不進埋點。
   - 憑證檔:系統開檔框選的路徑只留在這個行程(檔名可能含身分證,不回畫面);機器端在 bind 那一步自己讀檔、用憑證密碼打開、複製成固定檔名。
   不依賴 electron(tests/check_shell_sinopac_local.js 直接 require)。 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const SEAL_INFO = "sinopac-local-seal-v1", SEAL_AAD = "sinopac-local-v1";   // = runtime/sinopac_local._SEAL_INFO / _SEAL_AAD
const ID_RE = /^[A-Z][0-9A-D][0-9]{8}$/;   // = runtime sinopac_local._ID_RE(身分證與新舊式居留證,不驗檢查碼)
const KEY_RE = /^[^\s\0]{1,256}$/;          // = runtime sinopac_local._KEY_RE
const CA_PW_RE = /^[^\r\n\0]{0,128}$/;      // 空字串 = 憑證密碼就是身分證字號
const OPS = ["bind", "secrets", "setup", "probe", "sim_test", "start", "stop"];   // = runtime sinopac_local.LOCAL_OPS
const STEP_OPS = ["setup", "probe", "sim_test", "start"];
// 會拿 daemon 手上那組登入永豐的步驟(= runtime sinopac_local._LOGIN_OPS):帶 expect(存著的那組,同 bind 的封裝)
const LOGIN_OPS = ["probe", "sim_test", "start"];
const DEFERRED_WAIT_MS = 4000;   // 長步驟在 daemon 收下後才開始跑:回條等不到是常態,畫面看 sinopac_connect 狀態走
const RESEND_EVERY_MS = 30000;

function sealKey(secret) { return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(SEAL_INFO).digest(); }
// base64(nonce 12 ‖ 密文 ‖ tag 16):runtime/sinopac_local.open_sealed 收的形狀
function sealFor(secret, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", sealKey(secret), iv);
  c.setAAD(Buffer.from(SEAL_AAD, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}
const normId = (s) => (typeof s === "string" ? s.trim().toUpperCase() : "");

function createSinopac({ userData, seal, host, pickFile, now = () => Date.now() }) {
  const storePath = path.join(userData, "sinopac.bin");
  let picked = null, lastResend = 0;

  // kind 標記擋掉「把別的 safeStorage 密文換進來」(密文本身沒有完整性保護)
  function load() {
    try {
      if (!seal.available()) return null;
      const d = JSON.parse(seal.decrypt(fs.readFileSync(storePath)));
      if (!d || d.kind !== "sinopac" || !KEY_RE.test(d.api_key) || !KEY_RE.test(d.secret_key) || !ID_RE.test(d.person_id) || !CA_PW_RE.test(d.ca_password)) return null;
      return d;
    } catch (_) { return null; }
  }
  function write(d) {
    if (!seal.available()) return false;
    fs.mkdirSync(userData, { recursive: true });
    const tmp = storePath + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(tmp, seal.encrypt(JSON.stringify(Object.assign({ kind: "sinopac" }, d))), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
    return true;
  }
  // 畫面拿得到的:存過沒有、這次選了檔沒有、存的那組有沒有另設憑證密碼(f-capw 要不要一開始就展開)。沒有任何值
  function info() { const d = load(); return { saved: !!d, picked: !!picked, caSeparate: !!d && d.ca_password !== "" }; }
  function forget() { picked = null; try { fs.unlinkSync(storePath); } catch (_) {} return true; }
  // 框關掉:清這次選的檔(spec §3「框關掉就全清」,同 cxForget);存著的那組不動
  function closeBox() { picked = null; return true; }

  async function pick() {
    const p = await pickFile();
    if (!p) return { code: "CANCELED" };
    if (typeof p !== "string" || !path.isAbsolute(p) || !/\.pfx$/i.test(p) || p.length > 1024 || p.indexOf("\0") >= 0) return { code: "PFX_INVALID" };
    let st = null; try { st = fs.statSync(p); } catch (_) { return { code: "READ_FAILED" }; }
    if (!st.isFile()) return { code: "PFX_INVALID" };
    picked = p; return { code: "OK" };
  }

  // daemon 回的錯 "Refused: CODE: text" → CODE;daemon.js 自己的(DAEMON_DOWN、TIMEOUT…)原樣
  const codeOf = (err) => { const m = /^(?:\w+: )?([A-Z][A-Z_]+)(?::|$)/.exec(String(err || "")); return m ? m[1] : "FAILED"; };
  async function send(op, extra, timeoutMs) {
    const h = host();
    if (!h) return { code: "DAEMON_DOWN" };
    const r = await h.send("sinopac_local", Object.assign({ op }, extra || {}), { trusted: true, timeoutMs });
    if (r && r.ok) return { code: "OK", result: r.result };
    const e = r && r.error;
    if (e === "UNKNOWN_RESULT") return { code: "SENT" };
    // 過期的憑證:回條帶 "PFX_EXPIRED: not_after <ISO>"(一個日期,不是個資);其餘只回代號
    const na = /PFX_EXPIRED: not_after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(String(e || ""));
    return na ? { code: "PFX_EXPIRED", notAfter: na[1] } : { code: codeOf(e) };
  }
  const bundleOf = (d) => ({ api_key: d.api_key, secret_key: d.secret_key, person_id: d.person_id, ca_password: d.ca_password, live: true });

  /* 表單送出:欄位(null = 沿用存著的那組:〔改金鑰〕只清金鑰兩格、〔換憑證〕只清憑證檔)+ 這次選的檔 → bind。
     機器端先用憑證密碼(空 = 身分證字號)打開憑證,打不開就不寫任何東西、不登入永豐。成功才存 */
  async function bind(a) {
    const o = a || {}, old = load();
    const apiKey = typeof o.apiKey === "string" ? o.apiKey.trim() : old ? old.api_key : "";
    const secretKey = typeof o.secret === "string" ? o.secret.trim() : old ? old.secret_key : "";
    const personId = typeof o.personId === "string" ? normId(o.personId) : old ? old.person_id : "";
    const caPw = typeof o.caPassword === "string" ? o.caPassword : old ? old.ca_password : "";
    if (!KEY_RE.test(apiKey) || !KEY_RE.test(secretKey)) return { code: "BAD_KEY" };
    if (!ID_RE.test(personId)) return { code: "BAD_ID" };
    if (!CA_PW_RE.test(caPw)) return { code: "PFX_PASSWORD" };
    // 沒選檔:改金鑰／重新連接時沿用機器上存著的那張(runtime 沒有就回 NO_CERT);從來沒存過就得選
    if (!picked && !old) return { code: "NO_PFX" };
    if (!seal.available()) return { code: "NO_SEAL" };
    const h = host(); if (!h || typeof h.sealSinopac !== "function") return { code: "DAEMON_DOWN" };
    const d = { api_key: apiKey, secret_key: secretKey, person_id: personId, ca_password: caPw };
    const sealed = h.sealSinopac(Object.assign(bundleOf(d), picked ? { src: picked } : {}));
    if (!sealed) return { code: "DAEMON_DOWN" };
    const r = await send("bind", { sealed }, 30000);
    if (r.code !== "OK") return r;
    if (!write(d)) return { code: "NO_SEAL" };
    const na = r.result && r.result.cert && typeof r.result.cert.not_after === "string" ? r.result.cert.not_after : null;
    return { code: "OK", notAfter: na };
  }
  async function step(name) {
    if (STEP_OPS.indexOf(name) < 0) return { code: "BAD_ARGS" };
    let extra = {};
    // daemon 手上是哪一組只有它知道(bind 回 SENT 之後也可能失敗、留著舊的):把存著的那組封好交過去,
    // 對不上 daemon 回 SECRETS_STALE、不登入(runtime sinopac_local._held_matches,同統一 0.1.57)
    if (LOGIN_OPS.indexOf(name) >= 0) {
      const d = load(); if (!d) return { code: "NO_CREDS" };
      const h = host(); if (!h || typeof h.sealSinopac !== "function") return { code: "DAEMON_DOWN" };
      const expect = h.sealSinopac(bundleOf(d)); if (!expect) return { code: "DAEMON_DOWN" };
      extra = { expect };
    }
    return send(name, extra, name === "start" ? 10000 : DEFERRED_WAIT_MS);
  }
  /* daemon 每次起來都是空手:存著的那組要再交一次(.env 綁的是這一組才收,不然回 REBOUND)。主行程的 5 秒輪詢叫。
     report.sinopac_local.needs_secrets = .env 經連接流程綁了、這支 daemon 手上卻沒有那組(runtime sinopac_local.local_info) */
  async function resync(report) {
    const sl = report && report.sinopac_local;
    if (!sl || typeof sl !== "object" || sl.needs_secrets !== true) return null;
    if (now() - lastResend < RESEND_EVERY_MS) return null;
    const d = load(); if (!d) return null;
    const h = host(); if (!h || typeof h.sealSinopac !== "function") return null;
    const sealed = h.sealSinopac(bundleOf(d)); if (!sealed) return null;
    lastResend = now();
    return send("secrets", { sealed }, 10000);
  }
  return { info, forget, closeBox, pick, bind, step, resync, _load: load };
}
module.exports = { createSinopac, sealFor, OPS, STEP_OPS, LOGIN_OPS, ID_RE };
