// Blave 電腦版 — 雲端主機的永豐期貨開通(主行程用)。畫面在 renderer/sinopac.js 的雲端視角;設計 sinopac-connect-2026-11-17 §1.2,
// 機器那一端是 runtime/sinopac_connect.py(sinopac_setup / _pfx_key / _pfx / _probe / _sim_test / _finish)。
//   - 憑證檔、API Key、Secret、身分證字號、憑證密碼只在這個行程的記憶體裡,送出前用主機給的一次性公鑰封好
//     (RSA-OAEP-256 包 AES-256-GCM,AAD = key_id;同 cloud_capital.seal),api 只轉送密文。不寫檔、不 log、不進埋點。
//   - 檔案的 buffer 留到 forget()(關框):〔改金鑰〕在同一個框裡不必重選檔;主機那邊每次封包都要整包(含 pfx)。
//   - 回條與代號的解讀同 cloud_capital.interpret(長步驟的 UNKNOWN_RESULT = SENT,畫面看報告的 sinopac_connect 走)。
// 不 require electron(對話框、讀檔、送指令由 main.js 注入),測試用假的。
const crypto = require("crypto");
const CCAP = require("./cloud_capital");

const ALG = CCAP.ALG, PFX_MAX_BYTES = CCAP.PFX_MAX_BYTES;
const KEY_ID_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[A-Z][0-9A-D][0-9]{8}$/;   // = shell/sinopac_local.ID_RE = runtime sinopac_local._ID_RE
const KEY_RE = /^[^\s\0]{1,256}$/, CA_PW_RE = /^[^\r\n\0]{0,128}$/;
const STEPS = { setup: "sinopac_setup", probe: "sinopac_probe", sim_test: "sinopac_sim_test", start: "sinopac_finish" };

/* 封裝(純函式):明文 = UTF-8 JSON {pfx: base64, api_key, secret_key, person_id, ca_password}(runtime sinopac_connect.open_envelope 收的形狀) */
function seal(spkiB64, keyId, body) {
  const pub = crypto.createPublicKey({ key: Buffer.from(spkiB64, "base64"), format: "der", type: "spki" });
  const aes = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const pt = Buffer.from(JSON.stringify(body), "utf8");
  try {
    const c = crypto.createCipheriv("aes-256-gcm", aes, iv);
    c.setAAD(Buffer.from(keyId, "utf8"));
    const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    const ek = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aes);
    return { v: 1, alg: ALG, ek: ek.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
  } finally { aes.fill(0); pt.fill(0); }
}

/* opts:{ send(cmd, args, secrets) → cloudCmd.send 的回傳, pick() → Promise<string|null>, readFile(path) → Buffer, stat(path) → { size }, after() } */
function createSinopacCloud(opts) {
  let picked = null;   // Buffer:只在這裡
  const after = () => { try { if (opts.after) opts.after(); } catch (_) { /* 狀態刷新失敗不影響回傳 */ } };
  const forget = () => { if (picked) picked.fill(0); picked = null; return true; };
  const send = async (cmd, args) => { let r = null; try { r = await opts.send(cmd, args, null); } catch (_) { /* 當沒送到 */ } after(); return r; };

  async function pick() {
    let p = null; try { p = await opts.pick(); } catch (_) { return { code: "READ_FAILED" }; }
    if (!p) return { code: "CANCELED" };
    if (typeof p !== "string" || !/\.pfx$/i.test(p)) return { code: "PFX_INVALID" };
    let size = 0; try { size = opts.stat(p).size; } catch (_) { return { code: "READ_FAILED" }; }
    if (!(size > 0)) return { code: "READ_FAILED" };
    if (size > PFX_MAX_BYTES) return { code: "PFX_TOO_LARGE" };
    let buf; try { buf = opts.readFile(p); } catch (_) { return { code: "READ_FAILED" }; }
    if (!buf || buf.length !== size) { if (buf) buf.fill(0); return { code: "READ_FAILED" }; }
    forget(); picked = buf;
    return { code: "OK" };   // 檔名不回(可能帶身分證)
  }

  /* 欄位 → 公鑰 → 封裝 → sinopac_pfx。主機先用憑證密碼(空 = 身分證字號)打開憑證,打不開就不存、不登入永豐(cert.error)。
     KEY_EXPIRED:自動重要一把、只重試一次。欄位在這裡用完就不留 */
  async function upload(a) {
    const o = a || {}, apiKey = typeof o.apiKey === "string" ? o.apiKey.trim() : "", secret = typeof o.secret === "string" ? o.secret.trim() : "";
    const personId = typeof o.personId === "string" ? o.personId.trim().toUpperCase() : "", caPw = typeof o.caPassword === "string" ? o.caPassword : "";
    if (!KEY_RE.test(apiKey) || !KEY_RE.test(secret)) return { code: "BAD_KEY" };
    if (!ID_RE.test(personId)) return { code: "BAD_ID" };
    if (!CA_PW_RE.test(caPw)) return { code: "PFX_PASSWORD" };
    if (!picked) return { code: "NO_PFX" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const k = CCAP.interpret(await send("sinopac_pfx_key", {}));
      if (k.code === "SENT") return { code: "KEY_TIMEOUT" };
      if (k.code !== "OK") return k;
      const res = k.result || {};
      if (!KEY_ID_RE.test(String(res.key_id || "")) || res.alg !== ALG || typeof res.spki !== "string") return { code: "KEY_INVALID" };
      let envelope;
      try { envelope = seal(res.spki, res.key_id, { pfx: picked.toString("base64"), api_key: apiKey, secret_key: secret, person_id: personId, ca_password: caPw }); }
      catch (_) { return { code: "KEY_INVALID" }; }
      const u = CCAP.interpret(await send("sinopac_pfx", { key_id: res.key_id, envelope }));
      if (u.code === "KEY_EXPIRED" && attempt === 0) continue;
      return u;
    }
    return { code: "KEY_EXPIRED" };
  }
  async function step(name) {
    if (!Object.prototype.hasOwnProperty.call(STEPS, name)) return { code: "BAD_ARGS" };
    return CCAP.interpret(await send(STEPS[name], {}));
  }
  return { pick, upload, step, forget, hasFile: () => !!picked };
}

module.exports = { createSinopacCloud, seal, STEPS };
