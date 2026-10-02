#!/usr/bin/env node
// Windows 自動更新的離線簽章(稽核 2026-10-02 P1-1;app 那一端在 updater.js / updatesig.js)。在 Wei 的 Mac 上跑,不在 CI。
//   node tools/sign-update.js keygen
//       只做一次:產生 Ed25519 金鑰。私鑰寫到 BLAVE_UPDATE_SIGNING_KEY(0600、已存在就不覆寫),公鑰加進 shell/update-keys.json(要 commit)。
//   node tools/sign-update.js <A.B.C> --track win|win-test [--dry-run] [--first-release]
//       GitHub Actions desktop-win 的 stage job 已經把 Blave-Setup-<ver>.exe / .blockmap 傳到 desktop/<track>/、
//       沒簽的 yml 放在 desktop/<track>/staging/<ver>/latest.yml 之後跑。依序(任何一步不過就停,線上不受影響):
//       1. 私鑰檔 0600、是 Ed25519、它的公鑰在 update-keys.json 裡——不在的話,用它簽的版本已裝的 app 全部驗不過
//       2. staging 的 yml:版號對、還沒簽過;從正式網址把 exe 整個抓回來,sha512 要等於 yml 的
//       3. 線上 latest.yml(直接問 S3)的版號要比它小;只有 S3 回 404 才是第一次發(要加 --first-release),其他錯誤就停
//       4. 簽 → 用 app 同一支 verifyManifest 驗一次 → 傳成 desktop/<track>/latest.yml(這一刻起對外)→ 下載頁的固定檔名 Blave-Setup.exe
//       --dry-run:1–4 的檢查都做、印出簽好的 yml,不上傳。keygen --dry-run 只印會寫到哪,不產生、不寫檔。
// 設定:環境變數或 ~/.config/blave/desktop-release.env(同 release.js)。
//   BLAVE_UPDATE_SIGNING_KEY  私鑰檔路徑(預設 ~/.config/blave/desktop-update-ed25519.pem)
//   BLAVE_RELEASE_BUCKET      預設同 release.js
// AWS 同 release.js:固定 --profile blave-release,環境裡的 AWS_* 金鑰一律拿掉。
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const sig = require("../updatesig");
const { loadEnvFile, DEFAULTS } = require("./release");

const SHELL = path.join(__dirname, "..");
const KEYS_FILE = path.join(SHELL, "update-keys.json");
const DEFAULT_KEY = path.join(os.homedir(), ".config", "blave", "desktop-update-ed25519.pem");
const FEED_BASE = "https://download.blave.org/desktop";   // 同 .github/workflows/desktop-win.yml 的 meta
const TRACKS = ["win", "win-test"];

const die = (m) => { console.error("\n✗ " + m); process.exit(1); };
const step = (m) => console.log("\n▸ " + m);

function keygen(keyPath, keysFile) {
  if (fs.existsSync(keyPath)) throw new Error(`${keyPath} 已經存在:不覆寫(換掉它,之前那把簽的就沒人能續簽)`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  const pub = sig.publicKeyB64(publicKey), keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const had = keys.length;
  if (!keys.includes(pub)) keys.push(pub);
  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2) + "\n");
  return { pub, had };
}

function loadSigningKey(keyPath, keys) {
  if (!fs.existsSync(keyPath)) throw new Error(`找不到私鑰 ${keyPath}(BLAVE_UPDATE_SIGNING_KEY)`);
  if (fs.statSync(keyPath).mode & 0o077) throw new Error(`${keyPath} 的權限太寬(要 chmod 600)`);
  const k = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (k.asymmetricKeyType !== "ed25519") throw new Error(`${keyPath} 不是 Ed25519 私鑰`);
  const pub = sig.publicKeyB64(k);
  if (!keys.includes(pub)) throw new Error(`這把私鑰的公鑰(${pub})不在 update-keys.json 裡:用它簽,已裝的 app 全部驗不過`);
  return k;
}

/* 純函式(tests/check_shell_updatesig.js):staging 的 yml 原文 → 簽好的原文。
   exeSha512 = 從正式網址抓回來自己算的;liveVersion = 線上 latest.yml 的版號(null = 讀不到)。 */
function signYml({ ymlText, version, feed, privateKey, keys, exeSha512, liveVersion, first }) {
  const yaml = require("js-yaml");
  const info = yaml.load(ymlText);
  if (!info || typeof info !== "object") throw new Error("staging 的 yml 讀不懂");
  if ("blaveSignature" in info) throw new Error("staging 的 yml 已經帶簽章:不重簽");
  if (info.version !== version) throw new Error(`yml 的版號是 ${info.version},不是 ${version}`);
  const exe = `Blave-Setup-${version}.exe`;
  if (!Array.isArray(info.files) || !info.files.length || info.files.some((f) => !f || f.url !== exe)) throw new Error(`yml 的 files[] 不是只有 ${exe}`);
  if (exeSha512 !== info.sha512) throw new Error(`正式網址上的 ${exe} 跟 yml 的 sha512 對不上`);
  if (liveVersion) {
    if (first) throw new Error(`線上已經有 latest.yml(${liveVersion}),不是第一次發:拿掉 --first-release`);
    if (!sig.newer(version, liveVersion)) throw new Error(`線上已經是 ${liveVersion},${version} 沒有比它大`);
  } else if (!first) throw new Error("S3 上這條軌還沒有 latest.yml(404):真的是第一次發才加 --first-release");
  const signature = sig.signManifest(privateKey, { feed, version, sha512: info.sha512 });
  const signedText = ymlText.replace(/\s*$/, "\n") + `blaveSignature: ${signature}\n`;
  const m = sig.verifyManifest(yaml.load(signedText), { keys, feed, currentVersion: "0.0.0" });
  if (m.error || m.sha512 !== info.sha512) throw new Error("簽好的 yml 用 app 的驗法驗不過:" + (m.error || "sha512 不同"));
  return { signedText, exe };
}

const ymlVersion = (t) => (/^version:\s*(\S+)/m.exec(t || "") || [])[1] || null;
/* 純函式(tests/check_shell_updatesig.js):read() 丟出的錯誤帶 stderr(execFileSync 的形狀)。
   回線上版號,或 null = S3 明確說 404;讀得到卻沒有版號、403、throttle、連不上都 throw。 */
function liveFromS3(read) {
  let r;
  try { r = read(); } catch (e) {
    const err = String((e && (e.stderr || e.message)) || e);
    if (/\(404\)|NoSuchKey/.test(err)) return null;
    throw new Error(`讀不到線上的 latest.yml,而且不是 404(權限或網路?):${err.trim().split("\n").pop()}`);
  }
  const v = ymlVersion(r.stdout);
  if (!v) throw new Error("線上的 latest.yml 讀得到但沒有版號");
  return v;
}

const sha512Of = (buf) => crypto.createHash("sha512").update(buf).digest("base64");

async function main() {
  const argv = process.argv.slice(2);
  const version = argv[0], ti = argv.indexOf("--track"), track = ti >= 0 ? argv[ti + 1] : null;
  const dry = argv.includes("--dry-run"), first = argv.includes("--first-release");
  if (argv[0] !== "keygen" && (!/^\d+\.\d+\.\d+$/.test(version || "") || !TRACKS.includes(track))) die("用法:node tools/sign-update.js <A.B.C> --track win|win-test [--dry-run] [--first-release]\n      node tools/sign-update.js keygen");
  loadEnvFile();
  const keyPath = process.env.BLAVE_UPDATE_SIGNING_KEY || DEFAULT_KEY;
  if (argv[0] === "keygen") {
    if (dry) { console.log(`演練:不產生金鑰、不寫任何檔。真的跑會寫私鑰到 ${keyPath}(0600、已存在就停),公鑰加進 ${KEYS_FILE}`); return; }
    const { pub, had } = keygen(keyPath, KEYS_FILE);
    console.log(`私鑰:${keyPath}(0600)\n公鑰已加進 ${KEYS_FILE}:\n  ${pub}`);
    if (had) console.log(`⚠ update-keys.json 原本就有 ${had} 把:新舊並存一版之後,才能拿掉舊的那把`);
    console.log("接下來:把私鑰備份到離線的地方(弄丟 = 之後的 Windows 版已裝的人收不到),再 commit shell/update-keys.json。");
    return;
  }

  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  const kp = sig.keysProblem(keys);
  if (kp) die(`update-keys.json 不能用(${kp})`);
  let privateKey;
  try { privateKey = loadSigningKey(keyPath, keys); } catch (e) { die(e.message); }
  const feed = `${FEED_BASE}/${track}`, prefix = `desktop/${track}`, BUCKET = process.env.BLAVE_RELEASE_BUCKET || DEFAULTS.BLAVE_RELEASE_BUCKET;
  const PROFILE = "blave-release", awsEnv = { ...process.env };
  for (const k of Object.keys(awsEnv)) if (/^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|DEFAULT_PROFILE)$/.test(k)) delete awsEnv[k];
  const aws = (args, opts = {}) => execFileSync("aws", [...args, "--profile", PROFILE], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...awsEnv, AWS_PAGER: "" }, ...opts });

  step(`簽 ${version}(${track === "win" ? "正式軌" : "測試軌"} ${feed}${dry ? ",演練:不上傳" : ""})`);
  const who = aws(["sts", "get-caller-identity", "--query", "Arn", "--output", "text"]).trim();
  if (!/:user\/blave-desktop-release$/.test(who)) die(`AWS 身分不是發版專用的那一把(現在是 ${who.replace(/\d{12}/, "<acct>")})`);
  let ymlText;
  try { ymlText = aws(["s3", "cp", `s3://${BUCKET}/${prefix}/staging/${version}/latest.yml`, "-"], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { die(`讀不到 s3://${BUCKET}/${prefix}/staging/${version}/latest.yml(GitHub Actions 的 stage job 核准、跑完了嗎?):${String(e.stderr || e.message).trim().split("\n")[0]}`); }
  // 線上版號直接問 S3(不經 CDN 快取):只有 404 才算這條軌還沒有 latest.yml,其他錯誤停下來,不引導去加 --first-release
  let liveVersion;
  try {
    liveVersion = liveFromS3(() => ({ ok: true, stdout: aws(["s3", "cp", `s3://${BUCKET}/${prefix}/latest.yml`, "-"], { stdio: ["ignore", "pipe", "pipe"] }) }));
  } catch (e) { die(e.message); }
  step(`從正式網址把 Blave-Setup-${version}.exe 抓回來算 sha512`);
  const r = await fetch(`${feed}/Blave-Setup-${version}.exe`, { cache: "no-store" });
  if (r.status !== 200) die(`正式網址上抓不到 Blave-Setup-${version}.exe(status ${r.status}):stage job 跑完了嗎?`);
  let out;
  try { out = signYml({ ymlText, version, feed, privateKey, keys, exeSha512: sha512Of(Buffer.from(await r.arrayBuffer())), liveVersion, first }); } catch (e) { die(e.message); }
  if (dry) { step("演練:簽好的 latest.yml(沒有上傳)"); process.stdout.write(out.signedText); return; }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-sign-"));
  try {
    fs.writeFileSync(path.join(tmp, "latest.yml"), out.signedText);
    step(`上傳 ${prefix}/latest.yml`);
    aws(["s3", "cp", path.join(tmp, "latest.yml"), `s3://${BUCKET}/${prefix}/latest.yml`, "--cache-control", "no-cache", "--content-type", "text/yaml", "--only-show-errors"], { stdio: "inherit" });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  step(`✓ ${version} 從這一刻起對外(${feed}/)。之後的步驟失敗只警告,不要還原`);
  const warnings = [];
  try { aws(["s3", "cp", `s3://${BUCKET}/${prefix}/${out.exe}`, `s3://${BUCKET}/${prefix}/Blave-Setup.exe`, "--cache-control", "no-cache", "--metadata-directive", "REPLACE", "--only-show-errors"], { stdio: "inherit" }); }
  catch (e) { warnings.push(`下載頁的固定檔名 ${prefix}/Blave-Setup.exe 沒換成(手動補這一個檔即可):${String(e.message).split("\n")[0]}`); }
  let seen = null;
  for (let i = 0; i < 20 && seen !== version; i++) {
    await new Promise((res) => setTimeout(res, 6000));
    try { const t = await (await fetch(`${feed}/latest.yml?t=${Date.now()}`, { cache: "no-store" })).text(); seen = /^blaveSignature:/m.test(t) ? ymlVersion(t) : null; } catch (_) { /* 再試 */ }
  }
  if (seen !== version) warnings.push(`兩分鐘後從外面看到的 latest.yml 還不是簽好的 ${version}(CDN 還沒換完?)——過幾分鐘再看`);
  for (const w of warnings) console.log("  ⚠ " + w);
}
if (require.main === module) main().catch((e) => die((e && e.stack) || String(e)));
module.exports = { keygen, loadSigningKey, signYml, liveFromS3 };
