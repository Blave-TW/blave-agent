// Blave 電腦版 — 「連的是哪個 AI」這個決定存在哪、誰說了算(主行程用)。稽核 S1。
//
// 為什麼長這樣:
//   - 帳號 token 進不進 agent 的環境只看 kind === "blave"。而 agent 跟 app 是同一個系統用戶:userData 底下任何檔它都寫得到。
//     舊版的 connect.json 是明文,agent 改一個字(claude → blave),下一輪就拿到一顆它的主人明確沒選要交出來的計費憑證。
//   - 同一個用戶寫不到的地方不存在,所以不靠「藏」,靠**驗**:檔案帶一個 HMAC,金鑰是隨機產生、用 safeStorage(Keychain)包起來的。
//     agent 改得了檔、算不出 MAC。safeStorage 的密文本身沒有完整性保護(AES-CBC),所以不拿它直接包內容,只拿它保管金鑰——
//     金鑰被動過 = 驗不過 = 當成還沒連。
//   - 連金鑰檔一起還原成舊的那一份(回放)也擋:kind === "blave" 的紀錄綁著「存的當下那顆 token」的指紋,token 換過就不認。
//     回放得出來的只有 agent 當年就已經拿到過的那一顆。
//   - 一律「驗不過 = 沒連」:畫面回到連結頁讓用戶自己再選一次,不猜。
//   - 這個行程裡讀過 / 存過之後以記憶體為準,不再每一輪重讀檔案:跑到一半改檔不生效。
//
// 這個檔不 require electron;加解密與 token 指紋由呼叫端注入(測試用假的)。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KINDS = ["blave", "claude", "codex"];
const FILE = "connect.json", KEY_FILE = "connect-key.bin";

const clean = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
/* 畫面送來的選擇 → 要存的紀錄;不合規回 null。path 只收絕對路徑(它會被拿去 spawn)。 */
function normalize(choice) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice) || KINDS.indexOf(choice.kind) < 0) return null;
  const p = clean(choice.path, 1024);
  if (choice.kind !== "blave" && !(p && path.isAbsolute(p))) return null;
  return { kind: choice.kind, path: choice.kind === "blave" ? null : p, email: clean(choice.email, 254) };
}
const macOf = (key, r) => crypto.createHmac("sha256", key).update(JSON.stringify([r.kind, r.path, r.email, r.at, r.tok])).digest("hex");
// 先驗形狀才比:檔案是 agent 寫得到的——64 個非 ASCII 字元長度對、轉成 Buffer 卻不一樣長,timingSafeEqual 會直接拋(稽核 R1)
const macEq = (a, b) => typeof a === "string" && /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/* opts:{ dir, seal: { available(), encrypt(str) → Buffer, decrypt(Buffer) → str }, tokenFp() → string | null, now? } */
function createConnStore(opts) {
  const file = path.join(opts.dir, FILE), keyFile = path.join(opts.dir, KEY_FILE);
  const now = opts.now || (() => new Date().toISOString());
  let cached;   // undefined = 這個行程還沒讀過;null = 沒連

  function loadKey() {
    try { if (!opts.seal.available()) return null; const k = opts.seal.decrypt(fs.readFileSync(keyFile)); return /^[0-9a-f]{64}$/.test(k) ? k : null; } catch (_) { return null; }
  }
  function ensureKey() {
    const have = loadKey(); if (have) return have;
    if (!opts.seal.available()) return null;
    const k = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(keyFile, opts.seal.encrypt(k), { mode: 0o600 }); return k; } catch (_) { return null; }
  }
  const pub = (r) => (r ? { kind: r.kind, path: r.path, email: r.email, at: r.at } : null);

  function write(r) {
    const key = ensureKey();
    // 拿不到 Keychain:不落地(這個行程裡照用,下次開 app 要再選一次)。寫一份驗不了的檔沒有意義
    if (!key) { try { fs.unlinkSync(file); } catch (_) {} return; }
    try { fs.writeFileSync(file, JSON.stringify({ ...r, mac: macOf(key, r) }), { mode: 0o600 }); } catch (_) { /* 寫不進去:這個行程裡照用 */ }
  }

  function readFile() {
    let raw; try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
    const n = normalize(raw); if (!n) return null;
    const r = { ...n, at: clean(raw.at, 40), tok: clean(raw.tok, 64) };
    const key = loadKey();
    if (key) {
      if (!macEq(raw.mac, macOf(key, r))) return null;
      if (r.kind === "blave" && !(r.tok && r.tok === opts.tokenFp())) return null;   // 回放:存的時候不是現在這顆 token
      return r;
    }
    // 沒有金鑰 = 舊版留下的明文檔(或金鑰被刪了)。「用自己的 CLI」照認並補上 MAC;**blave 不認**——
    // 不然刪掉金鑰再寫一份明文就繞過去了。代價:舊版連 Blave AI 的人升上來要再按一次連結。
    if (r.kind === "blave") return null;
    const migrated = { ...r, at: r.at || now(), tok: null };
    write(migrated);
    return migrated;
  }

  return {
    // 任何例外 = 當成沒連(回連結頁再選一次)。這支在每一輪送訊息前都會被叫到:它拋 = 整個 app 永遠回「忙碌中」
    load() { if (cached === undefined) { try { cached = readFile(); } catch (_) { cached = null; } } return pub(cached); },
    save(choice) {
      const n = normalize(choice); if (!n) return null;
      cached = { ...n, at: now(), tok: n.kind === "blave" ? opts.tokenFp() : null };
      write(cached);
      return pub(cached);
    },
    clear() { cached = null; try { fs.unlinkSync(file); } catch (_) {} return true; },
    // 重新登入換了一顆 token:連的是 Blave AI 的話,紀錄要跟著綁到新的這一顆,不然下次開 app 會被當成回放
    reseal() { if (cached && cached.kind === "blave") { cached = { ...cached, tok: opts.tokenFp() }; write(cached); } },
  };
}

module.exports = { createConnStore, normalize, KINDS, FILE, KEY_FILE };
