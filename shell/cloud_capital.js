// Blave 電腦版 — 雲端主機的群益開通(主行程用)。畫面在 renderer/capital.js;設計 spec-capital-connect-v2 §2,
// 契約 blave-canon output/backend/capital-cloud-progress-2026-09-26.md(runtime/capital_connect.py 是另一端)。
//
// 為什麼長這樣:
//   - pfx 與匯出密碼只在這個行程的記憶體裡:檔案由這裡開對話框讀進來(renderer 只拿得到檔名與大小),
//     送出前用主機給的一次性公鑰封好(RSA-OAEP-256 包 AES-256-GCM,AAD = key_id),api 只轉送密文。
//     不寫檔、不 log、不進埋點;關框 / 換交易所 / 換帳號時 forget() 把 buffer 歸零。
//   - 一把公鑰只解一次(主機收到任何一包就刪),而且新要一把會作廢舊的:所以公鑰在「按上傳」那一刻才要,不在選檔時要。
//   - 長步驟(setup / pfx / probe / finish)在主機上是 Deferred:回條要等整步做完,常常超過 cloudcmd 的 20 秒窗 →
//     `UNKNOWN_RESULT` 是**正常的送出成功**,畫面看 portfolio 報告的 `capital_connect` 走。這裡把它叫 SENT。
//   - 主機的 runtime 還不認得 capital_* 時(過渡期):機器回 `unknown command`、或 api 還沒放行回 400 UNKNOWN_COMMAND → NOT_CAPABLE,
//     畫面照舊交給 agent(暫時,runtime 命令全面上線那一版拿掉)。
//   - 回條的 error 是用戶主機寫的字串:只取代號,原文不往上交。
// 這個檔不 require electron(對話框、讀檔、送指令都由 main.js 注入),測試用假的。
const crypto = require("crypto");

const ALG = "RSA-OAEP-256+A256GCM";
const PFX_MAX_BYTES = 16 * 1024;              // = runtime PFX_MAX_BYTES
const KEY_ID_RE = /^[0-9a-f]{32}$/;
// 身分證字號(英文 + 1/2)、新式居留證號(英文 + 8/9)、舊式居留證號(兩個英文,第二碼 A–D),後面 8 碼數字;與 web 同一條。
// 密碼不 trim(前後空白也是密碼的一部分,web 同)
const ID_RE = /^[A-Z][1289A-D]\d{8}$/;
const PW_RE = /^[^\r\n]{1,64}$/;
const CODE_RE = /^\s*[A-Za-z]*Error:\s*([A-Z][A-Z0-9_]+)(?::|\s*$)/;
// 畫面按得到的長步驟(capital_pfx_key / capital_pfx 只走 upload,不給畫面直接送)
const STEPS = {
  setup: ["capital_setup", {}],
  probe: ["capital_probe", {}],
  unlock: ["capital_probe", { after_unlock: true }],   // 307「我已解鎖」:主機只放行一次
  finish: ["capital_finish", {}],
};
// 綁 / 解綁用的 env 名(網頁送的就是小寫這兩個;機器端 casefold)
const ENV_NAMES = ["capital_api_key", "capital_password"];

/* 封裝(純函式,給跨語言往返測試直接叫):明文 = UTF-8 JSON {pfx: base64, password},形狀同 WebCrypto 版
   (密文尾端帶 16 bytes GCM tag)。回 envelope;公鑰壞掉會拋。 */
function seal(spkiB64, keyId, pfx, password) {
  const pub = crypto.createPublicKey({ key: Buffer.from(spkiB64, "base64"), format: "der", type: "spki" });
  const aes = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const pt = Buffer.from(JSON.stringify({ pfx: Buffer.from(pfx).toString("base64"), password }), "utf8");
  try {
    const c = crypto.createCipheriv("aes-256-gcm", aes, iv);
    c.setAAD(Buffer.from(keyId, "utf8"));
    const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    const ek = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aes);
    return { v: 1, alg: ALG, ek: ek.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
  } finally { aes.fill(0); pt.fill(0); }
}

/* cloudCmd.send 的回傳 → { code, … }(純函式)。
     OK          回條成功,result 原樣(只有 pfx_key 會用到)
     SENT        排進去了、回條還沒到(長步驟的常態)——看狀態
     NOT_CAPABLE 主機 / api 還不認得這個指令(過渡期)
     <CODE>      主機拒收的代號(BUSY、PW_RECHECK_NEEDED、KEY_EXPIRED…)
     REJECTED    主機拒收但認不出代號
     UNDELIVERED 確定沒送出(error / machineState 照 cloudcmd 的,畫面走雲端那組句子) */
function interpret(r) {
  if (r && r.ok) return { code: "OK", result: r.result };
  if (r && r.kind === "rejected") {
    const raw = String(r.error || "");
    if (/unknown command/i.test(raw)) return { code: "NOT_CAPABLE" };
    const m = CODE_RE.exec(raw);
    return { code: m ? m[1] : "REJECTED" };
  }
  if (r && r.error === "UNKNOWN_COMMAND") return { code: "NOT_CAPABLE" };
  if (r && r.kind === "unknown") return { code: "SENT" };
  return { code: "UNDELIVERED", error: (r && r.error) || "OFFLINE", kind: (r && r.kind) || "undelivered", machineState: (r && r.machineState) || null };
}

// 身分證字號 + 交易密碼 → credentials 的 secrets(名字在這裡決定,renderer 給不了)
function credSecrets(a) {
  if (!a || typeof a !== "object") return { error: "BAD_ARGS" };
  const id = typeof a.id === "string" ? a.id.trim().toUpperCase() : "", pw = typeof a.pw === "string" ? a.pw : "";
  if (!id || !pw) return { error: "INCOMPLETE" };
  if (!ID_RE.test(id) || !PW_RE.test(pw)) return { error: "BAD_FORMAT" };
  return { secrets: { capital_api_key: id, capital_password: pw } };
}

/* opts:{ send(cmd, args, secrets) → cloudCmd.send 的回傳, pick() → Promise<string|null>(選到的路徑), readFile(path) → Buffer,
          stat(path) → { size }, basename(path), after() 每次送完叫(main.js 拿來要一份新狀態) } */
function createCapital(opts) {
  let picked = null;   // { buf, name }:只在這裡,不往外交
  const after = () => { try { if (opts.after) opts.after(); } catch (_) { /* 狀態刷新失敗不影響回傳 */ } };
  const forget = () => { if (picked && picked.buf) picked.buf.fill(0); picked = null; };
  const send = async (cmd, args, secrets) => { let r = null; try { r = await opts.send(cmd, args, secrets || null); } catch (_) { /* 當沒送到 */ } after(); return r; };

  async function pickPfx() {
    let p = null; try { p = await opts.pick(); } catch (_) { return { code: "PICK_FAILED" }; }
    if (!p) return { code: "CANCELED" };
    let size = 0; try { size = opts.stat(p).size; } catch (_) { return { code: "READ_FAILED" }; }
    if (!(size > 0)) return { code: "READ_FAILED" };
    if (size > PFX_MAX_BYTES) return { code: "PFX_TOO_LARGE" };
    let buf; try { buf = opts.readFile(p); } catch (_) { return { code: "READ_FAILED" }; }
    if (!buf || buf.length !== size) { if (buf) buf.fill(0); return { code: "READ_FAILED" }; }
    forget();
    const name = String(opts.basename(p)).replace(/[\u0000-\u001f\u007f]/g, "").slice(-80);
    picked = { buf, name };
    return { code: "OK", name, size };
  }

  async function saveCreds(a) {
    const built = credSecrets(a);
    if (built.error) return { code: built.error };
    const r = await send("credentials", { venue: "capital" }, built.secrets);
    built.secrets.capital_password = ""; built.secrets = null;
    const out = interpret(r);
    // credentials 在主機上是同步寫檔:回條沒到就是不知道寫了沒(畫面講「沒回應」,不當成功)
    return out.code === "SENT" ? { code: "UNKNOWN_RESULT" } : out;
  }

  async function step(name) {
    if (!Object.prototype.hasOwnProperty.call(STEPS, name)) return { code: "BAD_ARGS" };
    const [cmd, args] = STEPS[name];
    return interpret(await send(cmd, args));
  }

  /* 公鑰 → 封裝 → capital_pfx。KEY_EXPIRED 是主機當場拒收(鑰匙逾時或被新的作廢):自動重要一把、只重試一次。
     password 在這裡用完就不留;pfx 的 buffer 留到 forget(),匯出密碼打錯時不必重選檔 */
  async function upload(password) {
    if (!picked) return { code: "NO_FILE" };
    if (typeof password !== "string" || !password || password.length > 256 || /[\r\n]/.test(password)) return { code: "BAD_PASSWORD" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const k = interpret(await send("capital_pfx_key", {}));
      if (k.code === "SENT") return { code: "KEY_TIMEOUT" };   // 同步指令 20 秒沒回:主機沒在聽
      if (k.code !== "OK") return k;
      const res = k.result || {};
      if (!KEY_ID_RE.test(String(res.key_id || "")) || res.alg !== ALG || typeof res.spki !== "string") return { code: "KEY_INVALID" };
      let envelope;
      try { envelope = seal(res.spki, res.key_id, picked.buf, password); } catch (_) { return { code: "KEY_INVALID" }; }
      const u = interpret(await send("capital_pfx", { key_id: res.key_id, envelope }));
      if (u.code === "KEY_EXPIRED" && attempt === 0) continue;
      return u;
    }
    return { code: "KEY_EXPIRED" };
  }

  async function unbind() { return interpret(await send("credentials_remove", { env: ENV_NAMES.slice() })); }

  return { pickPfx, saveCreds, step, upload, unbind, forget, hasFile: () => !!picked };
}

module.exports = { createCapital, seal, interpret, credSecrets, STEPS, ENV_NAMES, ALG, PFX_MAX_BYTES };
