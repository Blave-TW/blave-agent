/* 統一期貨 本機開通(電腦版 Windows)— 主行程這一側。畫面在 renderer/president.js;機器端在 runtime/president_connect.py 的 desktop 段。
   - 帳號、交易密碼、憑證密碼:safeStorage(Windows = DPAPI)加密存在 userData 的 president.bin,只有這個行程解得開(Wei 10-07,
     比照自帶 API 金鑰)。要用時封裝成 president_local 指令交給 daemon:AES-GCM,金鑰由 daemon 的 HMAC secret 衍生——那把只在這個行程
     與 daemon 的記憶體裡,所以落在指令佇列的檔案裡只有密文。renderer 只送進來一次、拿不回去;不 log、不進埋點。
   - 憑證:只看憑證e總管的預設資料夾 %USERPROFILE%\PSCCA\(不遞迴、不跟連結;Wei 10-07 Q3)。畫面只拿得到張數與到期日——
     檔名含身分證字號,不出這個行程;到期日讀檔名尾的 8 碼(開檔要密碼),真正的到期由機器端開檔時再驗一次。
   - 憑證e總管:統一官方的單一執行檔(TWCA TCEM.exe,免安裝),下載到 userData、SHA256 對上才以一般權限打開。**只負責打開**:
     不填、不點、不讀它的畫面,簡訊碼由用戶在統一自己的視窗輸入。
   不依賴 electron(tests/check_shell_president_local.js 直接 require)。 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), https = require("https");

const SEAL_INFO = "president-local-seal-v1", SEAL_AAD = "president-local-v1";   // = runtime/president_connect._SEAL_INFO / _SEAL_AAD
// research/president-mac-cert-experiment-2026-10-02.md §1:官方下載免登入、單一執行檔、asInvoker;檔名不能含 setup / install(會被要求提權)
const TCEM_URL = "https://download.pscnet.com.tw/download/ap/em/index.php";
const TCEM_SHA256 = "8257065bb11b409c11427298f7980059027becb44cabc3860eb0fcbafdfbbd5b";
const TCEM_MAX_BYTES = 8 * 1024 * 1024;
const CERT_CENTER_URL = "https://pki.pscnet.com.tw/";
const ACCOUNT_RE = /^[0-9]{11}$/;
const PW_RE = /^[^\r\n\0]{1,128}$/, CA_PW_RE = /^[^\r\n\0]{0,128}$/;   // 交易密碼不 trim(同群益 PW_RE);憑證密碼可以是空的
const OPS = ["setup", "cert", "secrets", "probe", "host", "test_order", "start", "stop"];   // = president_connect.LOCAL_OPS
const DEFERRED_WAIT_MS = 4000;   // 長步驟在 daemon 收下後才開始跑:回條等不到是常態,畫面看 president_connect 狀態走
const RESEND_EVERY_MS = 30000;

function sealKey(secret) { return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(SEAL_INFO).digest(); }
// base64(nonce 12 ‖ 密文 ‖ tag 16):runtime/president_connect.open_sealed 收的形狀
function sealFor(secret, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", sealKey(secret), iv);
  c.setAAD(Buffer.from(SEAL_AAD, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}
// 檔名尾的 8 碼日期(PSC_<身分證>_<到期日>.pfx)→ YYYY/MM/DD;不像日期就不講
function expiryFromName(name) {
  const m = /_(\d{4})(\d{2})(\d{2})\.pfx$/i.exec(String(name || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}/${m[2]}/${m[3]}` : null;
}
// 這台電腦在統一的部位口數(帳戶讀取器的 positions;讀不到 = 0,不猜)
function heldLots(report) {
  const a = report && report.account && report.account.venues && report.account.venues.president;
  const p = a && a.positions && typeof a.positions === "object" ? a.positions : {};
  return Object.keys(p).reduce((n, k) => { const s = p[k] && Number(p[k].size); return n + (isFinite(s) && s > 0 ? Math.round(s) : 0); }, 0);
}
function defaultFetch(url, max, hops = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!next.startsWith("https://")) { reject(new Error("REDIRECT")); return; }
        defaultFetch(next, max, hops - 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP_" + res.statusCode)); return; }
      const parts = []; let n = 0;
      res.on("data", (d) => { n += d.length; if (n > max) { req.destroy(new Error("TOO_LARGE")); return; } parts.push(d); });
      res.on("end", () => resolve(Buffer.concat(parts)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    req.on("error", reject);
  });
}

function createPresident({ userData, home, platform = process.platform, seal, host, pickFile, fetchBuffer = defaultFetch,
  spawnFn = require("child_process").spawn, openExternal = () => {}, now = () => Date.now() }) {
  const storePath = path.join(userData, "president.bin");
  const tcemDir = path.join(userData, "president"), tcemPath = path.join(tcemDir, "TCEM.exe");
  const certDir = path.join(home || "", "PSCCA");
  let picked = null, lastResend = 0, tcemBusy = false;

  /* 存:{kind, account, password, ca_password?, live}。live = 這個帳號現在在哪個環境(新帳號 false = 測試主機;切正式由 host 那一步改),
   daemon 重起時跟帳密一起交回去。kind 標記擋掉「把別的 safeStorage 密文換進來」(密文本身沒有完整性保護) */
  function load() {
    try {
      if (!seal.available()) return null;
      const d = JSON.parse(seal.decrypt(fs.readFileSync(storePath)));
      if (!d || d.kind !== "president" || !ACCOUNT_RE.test(d.account) || !PW_RE.test(d.password)) return null;
      if (d.ca_password !== undefined && !CA_PW_RE.test(d.ca_password)) return null;
      return d;
    } catch (_) { return null; }
  }
  function write(d) {
    if (!seal.available()) return false;
    fs.mkdirSync(userData, { recursive: true });
    const tmp = storePath + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(tmp, seal.encrypt(JSON.stringify(Object.assign({ kind: "president" }, d))), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
    return true;
  }
  function info() {
    const d = load();
    return { saved: !!d, account: d ? d.account : null, certSaved: !!d && d.ca_password !== undefined, windows: platform === "win32", pickedOther: !!picked };
  }
  function saveCreds(a) {
    const account = a && typeof a.account === "string" ? a.account.trim() : "", password = a && typeof a.password === "string" ? a.password : "";
    if (!ACCOUNT_RE.test(account)) return { code: "BAD_ACCOUNT" };
    if (!PW_RE.test(password)) return { code: "BAD_PW" };
    if (!seal.available()) return { code: "NO_SEAL" };
    const old = load();
    // 同一個帳號改密碼(被統一擋下之後):憑證沒換,憑證密碼照留;換帳號就要重選憑證
    const same = !!old && old.account === account;
    const keep = Object.assign(same && old.ca_password !== undefined ? { ca_password: old.ca_password } : {}, { live: same && old.live === true });
    return write(Object.assign({ account, password }, keep)) ? { code: "OK" } : { code: "NO_SEAL" };
  }
  function forget() { picked = null; try { fs.unlinkSync(storePath); } catch (_) {} return true; }

  // PSCCA 裡的 .pfx(只看這一層;Dirent.isFile() 對連結是 false)
  function listCerts() {
    let ents = [];
    try { ents = fs.readdirSync(certDir, { withFileTypes: true }); } catch (_) { return []; }
    const out = [];
    for (const e of ents) {
      if (!e.isFile() || !/\.pfx$/i.test(e.name)) continue;
      const p = path.join(certDir, e.name);
      try { out.push({ p, at: fs.lstatSync(p).mtimeMs, exp: expiryFromName(e.name) }); } catch (_) { /* 讀不到 = 沒有 */ }
    }
    return out.sort((x, y) => y.at - x.at);
  }
  function scan() {
    if (platform !== "win32") return { code: "NOT_WINDOWS" };
    const c = listCerts();
    return { code: "OK", found: c.length, expiry: c.length ? c[0].exp : null, newestAt: c.length ? Math.floor(c[0].at) : 0 };
  }
  async function pickOther() {
    const p = await pickFile();
    if (!p) return { code: "CANCELED" };
    if (typeof p !== "string" || !path.isAbsolute(p) || !/\.pfx$/i.test(p)) return { code: "BAD_FILE" };
    picked = p; return { code: "OK" };
  }

  async function openTcem() {
    if (platform !== "win32") return { code: "NOT_WINDOWS" };
    if (tcemBusy) return { code: "BUSY" };
    tcemBusy = true;
    try {
      let buf = null;
      try { buf = fs.readFileSync(tcemPath); } catch (_) { /* 還沒下載 */ }
      if (!buf || sha256(buf) !== TCEM_SHA256) {
        try { buf = await fetchBuffer(TCEM_URL, TCEM_MAX_BYTES); } catch (_) { openExternal(CERT_CENTER_URL); return { code: "DOWNLOAD" }; }
        // 雜湊對不上(官方改版、被換掉)就不執行:改帶用戶去憑證中心自己下載
        if (sha256(buf) !== TCEM_SHA256) { openExternal(CERT_CENTER_URL); return { code: "HASH" }; }
        fs.mkdirSync(tcemDir, { recursive: true });
        fs.writeFileSync(tcemPath, buf);
      }
      const c = spawnFn(tcemPath, [], { cwd: tcemDir, detached: true, stdio: "ignore", windowsHide: false });
      if (c && typeof c.on === "function") c.on("error", () => {});
      if (c && typeof c.unref === "function") c.unref();
      return { code: "OK" };
    } catch (_) { return { code: "START" }; }
    finally { tcemBusy = false; }
  }
  const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

  // daemon 回的錯 "ValueError: CODE: text" → CODE;daemon.js 自己的(DAEMON_DOWN、TIMEOUT…)原樣
  const codeOf = (err) => { const m = /^(?:\w+: )?([A-Z][A-Z_]+)(?::|$)/.exec(String(err || "")); return m ? m[1] : "FAILED"; };
  async function send(op, extra, timeoutMs) {
    const h = host();
    if (!h) return { code: "DAEMON_DOWN" };
    const r = await h.send("president_local", Object.assign({ op }, extra || {}), { trusted: true, timeoutMs });
    if (r && r.ok) return { code: "OK", result: r.result };
    const e = r && r.error;
    // 長步驟:daemon 收走了、回條還沒來 = 已經在跑(狀態檔會講結果)
    if (e === "UNKNOWN_RESULT") return { code: "SENT" };
    return { code: codeOf(e) };
  }
  function bundle(d, extra) {
    return Object.assign({ account: d.account, password: d.password, ca_password: d.ca_password === undefined ? "" : d.ca_password, live: d.live === true }, extra || {});
  }
  /* 選好憑證:找到的那張(PSCCA 最新)或「選別的檔案」那張 + 憑證密碼 → cert。成功才把憑證密碼存起來 */
  async function certUse(a) {
    const d = load(); if (!d) return { code: "NO_CREDS" };
    // null = 沿用存著的那組(改交易密碼後用同一張憑證重綁)
    const caPw = a && typeof a.caPassword === "string" ? a.caPassword : d.ca_password;
    if (typeof caPw !== "string" || !CA_PW_RE.test(caPw)) return { code: a && typeof a.caPassword === "string" ? "BAD_PW" : "NO_CA_PW" };
    const src = a && a.source === "picked" ? picked : (listCerts()[0] || {}).p;
    if (!src) return { code: "PFX_NONE_FOUND" };
    const h = host(); if (!h || typeof h.sealPresident !== "function") return { code: "DAEMON_DOWN" };
    const sealed = h.sealPresident(bundle(d, { ca_password: caPw, src }));
    if (!sealed) return { code: "DAEMON_DOWN" };
    // 新帳號 daemon 一律從測試主機開始(回條的 env 為準)
    const r = await send("cert", { sealed }, 30000);
    if (r.code === "OK") write(Object.assign({}, d, { ca_password: caPw }, r.result && r.result.env ? { live: r.result.env === "live" } : {}));
    return r;
  }
  /* host:{env:"test"|"live"} 或 {url:信上的網址}(一定是測試主機;正式只用 env)。daemon 收下就記住要去的環境——
     切換在它確認登入之前就做了,daemon 重起時交回去的要是新的那個 */
  async function step(name, opts) {
    if (OPS.indexOf(name) < 0 || name === "cert" || name === "secrets") return { code: "BAD_ARGS" };
    const o = opts || {};
    let extra = {};
    if (name === "probe" && o.afterUnlock === true) extra = { after_unlock: true };
    if (name === "host") {
      if (o.env === "test" || o.env === "live") extra = { env: o.env };
      else if (typeof o.url === "string" && o.url.trim() && o.url.length <= 200) extra = { url: o.url.trim() };
      else return { code: "BAD_ARGS" };
    }
    const r = await send(name, extra, name === "stop" ? 10000 : DEFERRED_WAIT_MS);
    if (name === "host" && (r.code === "OK" || r.code === "SENT")) { const d = load(); if (d) write(Object.assign({}, d, { live: extra.env === "live" })); }
    return r;
  }
  /* daemon 每次起來都是空手:存著的那組要再交一次(.env 已經綁的是這一組才會收,不然回 REBOUND)。主行程的 5 秒輪詢叫 */
  async function resync(report) {
    const pl = report && report.president_local, v = report && report.venues && report.venues.president;
    if (!pl || pl.secrets || !(v && v.credentials)) return null;
    if (now() - lastResend < RESEND_EVERY_MS) return null;
    const d = load(); if (!d || d.ca_password === undefined) return null;
    const h = host(); if (!h || typeof h.sealPresident !== "function") return null;
    const sealed = h.sealPresident(bundle(d)); if (!sealed) return null;
    lastResend = now();
    return send("secrets", { sealed }, 10000);
  }
  return { info, saveCreds, forget, scan, pickOther, openTcem, certUse, step, resync, heldLots, _load: load };
}
module.exports = { createPresident, sealFor, expiryFromName, heldLots, TCEM_SHA256, CERT_CENTER_URL };
