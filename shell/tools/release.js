#!/usr/bin/env node
// Blave 電腦版發版:一支指令從打包到上線。 node tools/release.js <A.B.C> [--dry-run]
//
// 做的事(任何一步不過就停,前面已上傳的檔不影響線上——線上只認 latest-mac.yml,而它最後才換):
//   1. 檢查:工作樹乾淨、在 main、新版號是嚴格 A.B.C 且比現在大(或已經 commit 在 HEAD 的 package.json)、憑證與 AWS 權限到位
//   2. 版號寫進 package.json(版號矩陣閘要求 package.json 跟 code 同一個 commit bump——已經 commit 的就略過不寫)
//      → npm run release(universal 包:簽章、公證、fuses、zip + dmg + latest-mac.yml)
//   3. 驗產物:codesign、Gatekeeper、防降版開關、yml 版號與 sha512 對得上 zip
//   4. 上傳 zip / blockmap / dmg(帶版號的檔已存在就拒絕)→ 從正式網址把 zip 整個抓回來比 sha512 → 才傳 latest-mac.yml(這一刻起對外)
//      → 下載頁的固定檔名 dmg → 清 CDN 快取 → 再抓一次確認。yml 換掉之前失敗:版號自動還原;之後失敗:只警告,不還原
//   5. 列出要 commit 的檔。**不自動 commit / tag / push**(blave-canon app-release.md 的規矩)。
//   整段跑在 shell/dist/.release.lock 底下:同一台機器第二支起來會直接停(2026-09-23 兩支相撞、白做兩次公證)。
//
// 憑證不寫在 repo:環境變數,或 ~/.config/blave/desktop-release.env(KEY=VALUE,一行一個;檔案要 0600)。
//   BLAVE_MAC_IDENTITY、APPLE_API_KEY、APPLE_API_KEY_ID、APPLE_API_ISSUER(簽章與公證,同 npm run release)
//   AWS_PROFILE(預設 blave-release:只能寫這個 bucket、只能清這個 distribution 的快取)
//   BLAVE_UPDATE_URL(預設下面那個)、BLAVE_RELEASE_BUCKET、BLAVE_RELEASE_DISTRIBUTION
//   BLAVE_RELEASE_PREFIX(測試軌,例:mac-test/):設了就整條發到 desktop/<前綴> 底下,包裡的更新網址也指到那裡——
//     正式的 desktop/mac/latest-mac.yml 一個 byte 都不碰,已安裝的正式版讀不到。沒設 = 正式軌,行為跟以前一模一樣。
//     其他護欄(https、AWS 身分、工作樹乾淨、版號、簽章公證)一條都不放寬。
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");

const SHELL = path.join(__dirname, ".."), REPO = path.join(SHELL, "..");
const DEFAULTS = { BLAVE_UPDATE_URL: "https://download.blave.org/desktop/mac", BLAVE_RELEASE_BUCKET: "blave-desktop-releases",
  BLAVE_RELEASE_DISTRIBUTION: "E2VCUSQ69E5KK5", AWS_PROFILE: "blave-release" };
const PREFIX = "desktop/mac";

/* 純函式(tests/check_shell_release.js):這次發到哪一條軌。回 { prefix, url, test } 或 { error }。
   測試軌的前綴只認 ^[a-z0-9-]+/$(不能有第二層、不能有 ..),而且不能就是正式那一條。
   同時自己設了 BLAVE_UPDATE_URL 的話兩個要對得上——不然會發出一個「檔案在測試軌、app 卻去正式軌找更新」的包。 */
function resolveTrack(env) {
  const raw = env.BLAVE_RELEASE_PREFIX, givenUrl = env.BLAVE_UPDATE_URL || null;
  if (raw === undefined || raw === "") return { prefix: PREFIX, url: givenUrl || DEFAULTS.BLAVE_UPDATE_URL, test: false };
  if (typeof raw !== "string" || !/^[a-z0-9-]+\/$/.test(raw)) return { error: "BLAVE_RELEASE_PREFIX 的格式要是 ^[a-z0-9-]+/$(例:mac-test/)" };
  const prefix = "desktop/" + raw.slice(0, -1);
  if (prefix === PREFIX) return { error: "BLAVE_RELEASE_PREFIX 不能是正式那一條(mac/)。要發正式版就不要設它" };
  const url = DEFAULTS.BLAVE_UPDATE_URL.slice(0, -PREFIX.length) + prefix;
  if (givenUrl && givenUrl !== url) return { error: `BLAVE_RELEASE_PREFIX 與 BLAVE_UPDATE_URL 對不上:前綴 ${raw} 對應的是 ${url}` };
  return { prefix, url, test: true };
}

const die = (m) => { console.error("\n✗ " + m); process.exit(1); };
const step = (m) => console.log("\n▸ " + m);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: SHELL, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
const semver = (v) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v) || []).slice(1).map(Number);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
/* 純函式(tests/check_shell_release.js):這個版號能不能發、要不要由這支腳本寫版號。回 { bump } 或 { error }。
   比現在大 → 照舊,腳本自己 bump。跟現在一樣 → 只有 HEAD 已經 commit 的 package.json 也是這個版號才放行(版號矩陣閘
   要求 package.json 跟 code 同一個 commit),而且不寫、不還原。工作樹改了版號但沒 commit 的,還是擋。重複發同一版由上傳那一步擋。 */
function mayRelease(version, current, committed) {
  if (newer(version, current)) return { bump: true };
  if (version === current && committed === current) return { bump: false };
  if (version === current) return { error: `新版號 ${version} 跟現在一樣,但 HEAD 的 shell/package.json 是 ${committed}:先把版號 commit 進去,或發更大的版號` };
  return { error: `新版號 ${version} 沒有比現在的 ${current} 大` };
}

/* 純函式(tests/check_shell_release.js):鎖檔怎麼處理。existing = 既有鎖的內容(null = 沒有鎖),isAlive(pid) = 那個 pid 還在嗎。
   回 { take: true }(沒鎖)、{ take: true, stale: true }(殘留鎖:pid 已不在,接手)或 { error }(另一支還在跑)。
   2026-09-23 兩支 release.js 撞在一起、白做兩次公證——同一台打包機同時只准一支。 */
function lockDecision(existing, isAlive) {
  if (!existing) return { take: true };
  const { pid, version, startedAt } = existing;
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return { error: `另一支 release.js 還在跑(pid ${pid},版 ${version},自 ${startedAt})` };
  return { take: true, stale: true };
}
const LOCK = path.join(SHELL, "dist", ".release.lock");
// EPERM = 程序存在但不是我們的(例如另一個使用者跑的),也算活著
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
let lockHeld = false;
const releaseLock = () => { if (!lockHeld) return; lockHeld = false; try { fs.unlinkSync(LOCK); } catch (_) { /* 已經不在 */ } };
function takeLock(version) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  let fd;
  try { fd = fs.openSync(LOCK, "wx"); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let existing = {}; try { existing = JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch (_) { /* 讀不懂就當沒有 pid */ }
    const d = lockDecision(existing, alive);
    if (d.error) die(d.error);
    console.error(`  ⚠ 殘留鎖(pid ${existing.pid} 已不在),接手`);
    fd = fs.openSync(LOCK, "w");
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, version, startedAt: new Date().toISOString() })); fs.closeSync(fd);
  lockHeld = true;
  process.on("exit", releaseLock);   // 正常結束、die()、沒接到的例外都會走到這;訊號要自己轉成 exit(下面)
}

function loadEnvFile() {
  const f = path.join(os.homedir(), ".config", "blave", "desktop-release.env");
  if (!fs.existsSync(f)) return;
  if (fs.statSync(f).mode & 0o077) die(`${f} 的權限太寬(要 chmod 600)`);
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
// 封裝後才被寫進 .app 的檔(外部程序就地跑了包裡的 python3):會讓 codesign --verify --strict 失敗,在這裡點名是哪幾個。
// 隨包 Python 比對 sign-python.js 預編完記下的清單(預編的 .pyc 在清單內);其餘位置不該有任何 __pycache__
function foreignFilesInApps(dist) {
  const found = [], signPython = require("./sign-python.js");
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { const p = path.join(d, e.name); if (e.name === "__pycache__") found.push(p); else if (!skip.includes(p)) walk(p); } };
  let skip = [];
  for (const d of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
    const out = path.join(dist, d), a = path.join(out, "Blave.app");
    if (!/^mac/.test(d) || !fs.existsSync(a)) continue;
    const res = path.join(a, "Contents", "Resources");
    skip = signPython.PY_ARCHES.map((x) => path.join(res, `python-${x}`));
    walk(a);
    for (const f of signPython.extraPythonFiles(out)) found.push(path.join(res, f));
  }
  return found;
}
const sha512 = (f) => crypto.createHash("sha512").update(fs.readFileSync(f)).digest("base64");

// 純函式(tests/check_shell_release.js):上傳計畫。順序就是安全性——對外生效的兩個檔(yml、下載頁的固定檔名 dmg)永遠最後。
function uploadPlan(version, arch, prefix = PREFIX) {
  const PREFIX = prefix, base = `Blave-${version}-${arch}`, IMM = "public, max-age=31536000, immutable";
  return [
    { file: `${base}-mac.zip`, key: `${PREFIX}/${base}-mac.zip`, cache: IMM, versioned: true },
    { file: `${base}-mac.zip.blockmap`, key: `${PREFIX}/${base}-mac.zip.blockmap`, cache: IMM, versioned: true },
    { file: `${base}.dmg`, key: `${PREFIX}/${base}.dmg`, cache: IMM, versioned: true },
    { file: "latest-mac.yml", key: `${PREFIX}/latest-mac.yml`, cache: "no-cache", goLive: true },
    // 官網下載頁連這一個固定檔名,不用每版改連結;不快取。排在 yml 之後:前面任何一步中止,下載頁都還是舊版
    { file: `${base}.dmg`, key: `${PREFIX}/Blave-${arch}.dmg`, cache: "no-cache", afterLive: true },
  ];
}

/* 上傳迴圈(io 可注入,測試用假的跑):
   - 帶版號的 key 已經存在就拒絕(稽核 M1):它們是 immutable 一年快取,覆寫之後 CDN 邊緣還是舊檔,
     yml 的 sha512 對不上 → 全體更新失敗。中途失敗的版號不重用,發下一個。
   - 換 yml 之前,把 zip 從正式網址整個抓回來比 sha512(不是只比大小):用戶實際會拿到的就是這一份。
   - yml 一傳上去 = 已經對外。之後的事(固定檔名 dmg、清快取、輪詢)失敗只警告,**不能**報成發版失敗——
     不然會有人去還原版號,commit 與 tag 就漏了(稽核 M3)。 */
async function publish(plan, io) {
  for (const p of plan.filter((x) => x.versioned)) if (await io.exists(p.key)) throw new Error(`${p.key} 已經在 bucket 裡。帶版號的檔不能覆寫(CDN 快取一年),這個版號作廢,請發下一個版號`);
  let live = false; const warnings = [];
  for (const p of plan) {
    if (p.goLive) {
      const got = await io.fetchSha512(plan[0].key), want = io.localSha512(plan[0].file);
      if (got !== want) throw new Error(`正式網址上的 zip 跟本機的不一樣(sha512 不符)。latest-mac.yml 還沒換,線上不受影響`);
    }
    if (live) { try { await io.upload(p); } catch (e) { warnings.push(`${p.key} 沒傳成:${e.message}`); } continue; }
    await io.upload(p);
    if (p.goLive) { live = true; io.say(`✓ latest-mac.yml 已換——新版從這一刻起對外生效。之後的步驟失敗都不要還原版號`); }
  }
  return { live, warnings };
}

async function main() {
  const version = process.argv[2], dry = process.argv.includes("--dry-run"), first = process.argv.includes("--first-release");
  if (!semver(version || "").length) die("用法:node tools/release.js <A.B.C> [--dry-run] [--first-release]   (版號必須是嚴格的三段數字:Squirrel 的防降版要求)");
  // 任何檢查之前先上鎖(演練也上):第二支起來就停在這,不會跑到打包、公證
  takeLock(version);
  let restore = () => {};   // 寫了版號之後才有東西可還原(下面重新指定)
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(sig, () => { restore(); process.exit(code); });
  // 產物是 universal(一份同時給 Apple Silicon 與 Intel),但發版流程只在 arm64 打包機驗過:Rosetta 下的 node 直接擋
  if (process.arch !== "arm64") die(`這支腳本只在 arm64 打包機跑過(現在的 node 是 ${process.arch}——Rosetta 下的 node?)`);
  loadEnvFile();
  const track = resolveTrack(process.env);
  if (track.error) die(track.error);
  process.env.BLAVE_UPDATE_URL = track.url;   // 打包的子行程讀的就是這個:包裡的更新網址跟上傳的位置永遠是同一條軌
  for (const k of Object.keys(DEFAULTS)) if (!process.env[k]) process.env[k] = DEFAULTS[k];
  const { BLAVE_UPDATE_URL: URL_BASE, BLAVE_RELEASE_BUCKET: BUCKET, BLAVE_RELEASE_DISTRIBUTION: DIST } = process.env;
  const pkgPath = path.join(SHELL, "package.json"), lockPath = path.join(SHELL, "package-lock.json");
  // 檔名裡的架構字樣:universal 包一律 "universal"(electron-builder 的命名),不是打包機的 process.arch。
  // 已裝的 arm64 版 electron-updater 在 yml 裡找不到帶 arm64 字樣的檔時會退而拿沒標架構的那個——universal zip 就是它
  const current = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version, arch = "universal", dist = path.join(SHELL, "dist");
  // AWS 身分釘死(稽核 M4):一律 --profile,而且把環境裡的 AWS_ACCESS_KEY_ID 之類拿掉——它們的優先權高於 profile,
  // 不拿掉的話腳本會靜靜用別把(可能是管理員)金鑰發版,「沒有 Delete、碰不到別的 bucket」那張安全網就沒了
  const PROFILE = "blave-release", awsEnv = { ...process.env };
  for (const k of Object.keys(awsEnv)) if (/^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|DEFAULT_PROFILE)$/.test(k) || /^APPLE_|^BLAVE_MAC_/.test(k)) delete awsEnv[k];
  const aws = (args, opts = {}) => run("aws", [...args, "--profile", PROFILE], { env: { ...awsEnv, AWS_PAGER: "" }, ...opts });
  const buildEnv = { ...process.env }; for (const k of Object.keys(buildEnv)) if (/^AWS_/.test(k)) delete buildEnv[k];   // 打包的子行程不需要 AWS 憑證

  step(`檢查(現在 ${current} → 要發 ${version}${dry ? ",演練模式:不上傳" : ""})`);
  console.log(track.test ? `  ⚠ 測試軌:發到 s3://${BUCKET}/${track.prefix}/ ,更新網址 ${URL_BASE}(正式的 ${PREFIX}/ 不會被碰到)` : `  正式軌:s3://${BUCKET}/${track.prefix}/ ,更新網址 ${URL_BASE}`);
  const committed = JSON.parse(run("git", ["-C", REPO, "show", "HEAD:shell/package.json"])).version;
  const gate = mayRelease(version, current, committed);
  if (gate.error) die(gate.error);
  if (!gate.bump) console.log(`  版號 ${version} 已經 commit 在 HEAD 的 package.json:不再寫入`);
  if (run("git", ["-C", REPO, "status", "--porcelain"]).trim()) die("工作樹不乾淨:先 commit 或清掉再發版(發出去的包要對得回一個 commit)");
  if (run("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"]).trim() !== "main") die("不在 main");
  for (const k of ["BLAVE_MAC_IDENTITY", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) if (!process.env[k]) die(`缺 ${k}(環境變數或 ~/.config/blave/desktop-release.env)`);
  if (!/^https:\/\/[^\s]+[^/]$/.test(URL_BASE)) die("BLAVE_UPDATE_URL 要 https,而且結尾不帶 /");
  // 線上版號:匿名 GET,演練模式也查。讀不到就停——只有第一次發版(線上還沒有 yml)才用 --first-release 放行
  const liveYml = await fetch(`${URL_BASE}/latest-mac.yml?t=${Date.now()}`, { cache: "no-store" }).catch(() => null);
  if (liveYml && liveYml.status === 200) {
    const lv = (/^version:\s*(\S+)/m.exec(await liveYml.text()) || [])[1];
    if (first) die(`線上已經有 latest-mac.yml(${lv}),不是第一次發版:拿掉 --first-release`);
    if (!lv || !newer(version, lv)) die(`線上已經是 ${lv},${version} 沒有比它大`);
  } else if (!first) die(`讀不到線上的 latest-mac.yml(status ${liveYml ? liveYml.status : "連不上"})。真的是第一次發版才加 --first-release`);
  if (!dry) {
    const who = aws(["sts", "get-caller-identity", "--query", "Arn", "--output", "text"]).trim();
    if (!/:user\/blave-desktop-release$/.test(who)) die(`AWS 身分不是發版專用的那一把(現在是 ${who.replace(/\d{12}/, "<acct>")})`);
    console.log("  AWS 身分:" + who.replace(/\d{12}/, "<acct>"));
  }

  step("閘門測試");
  for (const t of fs.readdirSync(path.join(REPO, "tests")).filter((f) => /^(check_shell_.*|check_version_matrix_shell)\.js$/.test(f) && f !== "check_shell_paths.js"))
    try { run(process.execPath, [path.join(REPO, "tests", t)], { stdio: "pipe" }); } catch (e) { die(`${t} 沒過:\n${e.stdout || ""}`); }

  step(gate.bump ? "寫入版號、打包(簽章 + 公證,要幾分鐘)" : "打包(簽章 + 公證,要幾分鐘)");
  const before = { pkg: fs.readFileSync(pkgPath, "utf8"), lock: fs.readFileSync(lockPath, "utf8") };
  let wentLive = false;
  // yml 換掉之前的任何失敗(含 Ctrl-C)→ 版號還原,回到可以重跑的狀態;換掉之後絕不還原(稽核 M2、M3)。沒寫過的就沒東西可還原
  restore = () => { if (wentLive || !gate.bump) return; fs.writeFileSync(pkgPath, before.pkg); fs.writeFileSync(lockPath, before.lock); console.error("  package.json / package-lock.json 的版號已還原"); };
  try {
    if (gate.bump) execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: SHELL, stdio: "pipe", env: buildEnv });
    for (const e of fs.readdirSync(dist)) if (path.join(dist, e) !== LOCK) fs.rmSync(path.join(dist, e), { recursive: true, force: true });   // 清舊產物,鎖要留著
    execFileSync("npm", ["run", "release"], { cwd: SHELL, stdio: "inherit", env: buildEnv });

    step("驗產物");
    const plan = uploadPlan(version, arch, track.prefix), app = path.join(dist, `mac-${arch}`, "Blave.app");
    const foreign = foreignFilesInApps(dist);
    if (foreign.length) throw new Error(`.app 封裝後多出檔案(有程序就地跑了包裡的 python3?):\n  ${foreign.slice(0, 5).join("\n  ")}`);
    for (const p of plan) if (!fs.existsSync(path.join(dist, p.file))) throw new Error(`沒有產出 ${p.file}`);
    const plist = (a, k) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, path.join(a, "Contents", "Info.plist")]).trim();
    const checkApp = (a, label) => {
      run("codesign", ["--verify", "--deep", "--strict", a]); run("spctl", ["--assess", "--type", "execute", a]);
      if (plist(a, "ElectronSquirrelPreventDowngrades") !== "true") throw new Error(label + ":防降版開關不在 Info.plist");
      if (plist(a, "CFBundleShortVersionString") !== version) throw new Error(label + ":app 的版號不是 " + version);
    };
    checkApp(app, "dist");
    // 用戶更新時拿到的是 zip 解出來的那一份(帶 Python framework,symlink 是已知的坑):解開再驗一次
    const unz = fs.mkdtempSync(path.join(os.tmpdir(), "blave-rel-"));
    try { run("ditto", ["-x", "-k", path.join(dist, plan[0].file), unz]); checkApp(path.join(unz, "Blave.app"), "zip"); } finally { fs.rmSync(unz, { recursive: true, force: true }); }
    run("xcrun", ["stapler", "validate", path.join(dist, `Blave-${version}-${arch}.dmg`)]);
    const yml = fs.readFileSync(path.join(dist, "latest-mac.yml"), "utf8");
    if ((/^version:\s*(\S+)/m.exec(yml) || [])[1] !== version) throw new Error("latest-mac.yml 的版號不對");
    if (!yml.includes(sha512(path.join(dist, plan[0].file)))) throw new Error("latest-mac.yml 的 sha512 跟 zip 對不上");
    const asarPkg = JSON.parse(require("@electron/asar").extractFile(path.join(app, "Contents", "Resources", "app.asar"), "package.json").toString());
    if (asarPkg.blaveUpdateUrl !== URL_BASE || asarPkg.blaveRelease !== true) throw new Error("包裡的更新網址或發佈旗標不對:" + JSON.stringify({ blaveUpdateUrl: asarPkg.blaveUpdateUrl, blaveRelease: asarPkg.blaveRelease }));
    execFileSync(process.execPath, [path.join(REPO, "tests", "check_shell_paths.js")], { stdio: "inherit" });   // signed 段:同 Team、fuses、staple

    if (dry) { step(`演練模式:會上傳這些(順序就是下面這樣;${track.test ? "測試軌" : "正式軌"},對外網址 ${URL_BASE}/)`); for (const p of plan) console.log(`  s3://${BUCKET}/${p.key}   [${p.cache}]`); restore(); step(gate.bump ? "演練完成,版號已還原" : "演練完成"); return; }

    const res = await publish(plan, {
      say: (m) => { wentLive = true; step(m); },
      exists: async (key) => { try { aws(["s3api", "head-object", "--bucket", BUCKET, "--key", key], { stdio: "pipe" }); return true; } catch (_) { return false; } },
      upload: async (p) => { step(`上傳 ${p.key}`); aws(["s3", "cp", path.join(dist, p.file), `s3://${BUCKET}/${p.key}`, "--cache-control", p.cache, "--only-show-errors"], { stdio: "inherit" }); },
      localSha512: (f) => sha512(path.join(dist, f)),
      fetchSha512: async (key) => { step("從正式網址把 zip 抓回來比對"); const r = await fetch(`${URL_BASE}/${path.basename(key)}`, { cache: "no-store" }); if (r.status !== 200) throw new Error(`正式網址上抓不到 zip(status ${r.status})。latest-mac.yml 還沒換,線上不受影響`); return crypto.createHash("sha512").update(Buffer.from(await r.arrayBuffer())).digest("base64"); },
    });
    // 從這裡開始新版已經對外:失敗只警告
    try { aws(["cloudfront", "create-invalidation", "--distribution-id", DIST, "--paths", `/${track.prefix}/latest-mac.yml`, `/${track.prefix}/Blave-${arch}.dmg`]); } catch (e) { res.warnings.push("清 CDN 快取沒成功(yml 是 no-cache,通常不影響):" + e.message.split("\n")[0]); }
    let seen = null;
    for (let i = 0; i < 20 && seen !== version; i++) {
      await new Promise((r) => setTimeout(r, 6000));
      try { seen = (/^version:\s*(\S+)/m.exec(await (await fetch(`${URL_BASE}/latest-mac.yml?t=${Date.now()}`, { cache: "no-store" })).text()) || [])[1]; } catch (_) { /* 再試 */ }
    }
    if (seen !== version) res.warnings.push(`兩分鐘後從外面看到的 latest-mac.yml 還是 ${seen}(CDN 還沒換完?)——新版已經上傳,**不要還原版號**,過幾分鐘再看`);
    step(track.test ? `✓ ${version} 已放上測試軌(${URL_BASE}/):只有更新網址指到這裡的包會拿到` : `✓ ${version} 已上線:已安裝的 app 會在 4 小時內開始下載`);
    for (const w of res.warnings) console.log("  ⚠ " + w);
    console.log(gate.bump ? "接下來(不自動做):把 shell/package.json 與 package-lock.json 的版號改動提交、打標籤、推上去。" : "接下來(不自動做):版號已在 HEAD,打標籤、推上去。");
  } catch (e) {
    if (wentLive) { console.error("\n⚠ 新版已經對外,但後續步驟出錯(不要還原版號):" + (e && e.message)); process.exit(2); }
    restore(); die((e && e.message) || String(e));
  }
}
if (require.main === module) main().catch((e) => die(e && e.stack || String(e)));
module.exports = { uploadPlan, publish, newer, semver, mayRelease, resolveTrack, foreignFilesInApps, lockDecision };
