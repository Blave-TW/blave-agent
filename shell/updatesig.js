// Blave 電腦版 Windows 自動更新的離線簽章(稽核 2026-10-02 P1-1)。
// 沒有 Authenticode 的 NSIS 包,electron-updater 只比 latest.yml 裡的 sha512——它跟安裝檔出自同一個地方,能寫 S3 就能一起換。
// 所以 latest.yml 多帶一行 blaveSignature:Wei 本機那把 Ed25519 私鑰(不在 CI、不在 repo)對「更新網址 + 版號 + 安裝檔 sha512」的簽章。
// app 內嵌公鑰(update-keys.json),下載完、暫存之前驗(updater.js);簽的那一支是 tools/sign-update.js,兩邊共用這個檔。
// 不 require electron:node 測試與簽章腳本都要跑得動。
const crypto = require("crypto"), fs = require("fs");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const newer = (a, b) => {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] > +y[i];
  return false;
};
const trimFeed = (u) => String(u || "").replace(/\/+$/, "");

// 簽的是這幾個值,不是 yml 原文:yml 排版、key 順序、CI 改檔名都不影響。帶更新網址 = 測試軌簽的那份搬到正式軌不算數
function payload({ feed, version, sha512 }) {
  return Buffer.from(["blave-desktop-update/1", "feed " + trimFeed(feed), "version " + version, "sha512 " + sha512].join("\n"), "utf8");
}

// update-keys.json 每一項 = Ed25519 公鑰的 SPKI DER base64(sign-update.js keygen 寫進去的格式)。陣列是為了換鑰:新舊兩把並存一版再拿掉舊的
function publicKey(b64) {
  const k = crypto.createPublicKey({ key: Buffer.from(String(b64), "base64"), format: "der", type: "spki" });
  if (k.asymmetricKeyType !== "ed25519") throw new Error("not an ed25519 key");
  return k;
}
const publicKeyB64 = (k) => (k.type === "public" ? k : crypto.createPublicKey(k)).export({ format: "der", type: "spki" }).toString("base64");

// 打包閘門與 app 啟動共用:null = 可用。沒有公鑰的包發出去,之後每一版它都會拒收,只能請用戶手動重裝
function keysProblem(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return "no update public key";
  for (const k of keys) { try { publicKey(k); } catch (_) { return "unreadable update public key"; } }
  return null;
}

const signManifest = (privateKey, fields) => crypto.sign(null, payload(fields), privateKey).toString("base64");

/* info = electron-updater 解析好的 latest.yml(js-yaml load,多出來的 key 原樣留著)。回 { sha512 } 或 { error }。
   形狀卡死:頂層與每一筆 files[] 的 sha512 都要等於簽過的那個(只有 sha2 的那筆也算不等),不准有 packages
   (web installer 的 7z 另外下載、不經過驗章),不准 isAdminRightsRequired。這樣就不必去猜 electron-updater 會挑 files 裡的哪一筆。 */
function verifyManifest(info, { keys, feed, currentVersion }) {
  if (!info || typeof info !== "object") return { error: "no update info" };
  const { version, sha512, blaveSignature: sig } = info;
  if (typeof sig !== "string" || !sig) return { error: "manifest is not signed" };
  if (typeof version !== "string" || !SEMVER.test(version)) return { error: "manifest version is not A.B.C" };
  if (typeof sha512 !== "string" || !sha512) return { error: "manifest has no sha512" };
  if (info.packages != null) return { error: "manifest lists web-installer packages" };
  const files = Array.isArray(info.files) ? info.files : [];
  if (!files.length || files.some((f) => !f || f.sha512 !== sha512)) return { error: "manifest files[] sha512 differs from the signed one" };
  // 沒簽到的這個欄位會讓 electron-updater 改用 elevate.exe 跑安裝檔(跳 UAC);per-user 安裝用不到,一律不收
  if (info.isAdminRightsRequired || files.some((f) => f.isAdminRightsRequired)) return { error: "manifest asks for admin rights" };
  const data = payload({ feed, version, sha512 }), raw = Buffer.from(sig, "base64");
  let ok = false;
  for (const k of Array.isArray(keys) ? keys : []) { try { if (crypto.verify(null, data, publicKey(k), raw)) { ok = true; break; } } catch (_) { /* 這把讀不懂:換下一把 */ } }
  if (!ok) return { error: "manifest signature does not verify" };
  if (!newer(version, currentVersion)) return { error: `manifest version ${version} is not newer than ${currentVersion}` };
  return { sha512 };
}

// 安裝檔一百多 MB:用串流算,不在主行程整個讀進記憶體
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha512");
    fs.createReadStream(file).on("error", reject).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("base64")));
  });
}

module.exports = { payload, publicKey, publicKeyB64, keysProblem, signManifest, verifyManifest, sha512File, newer };
