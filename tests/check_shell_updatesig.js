// Windows 自動更新的離線簽章(稽核 2026-10-02 P1-1):shell/updatesig.js、updater.js 的掛點、tools/sign-update.js、打包閘門與 CI 形狀。
// 偽造 yml、改 sha、降版、沒簽章、換軌重放、快取路徑都不能裝;正常簽章要裝得起來。第三段用真的 electron-updater(NsisUpdater)
// 對本機 HTTP 跑完整的「查 → 下載 → 驗 → 暫存」,證明掛點真的擋得住。金鑰全是測試當場產的,不讀任何真私鑰。
// 跑法:node tests/check_shell_updatesig.js
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), http = require("http"), cp = require("child_process");
const { EventEmitter } = require("events");
const SHELL = path.join(__dirname, "..", "shell");
const sig = require("../shell/updatesig.js");
const { createUpdater } = require("../shell/updater.js");
const signer = require("../shell/tools/sign-update.js");
const yaml = require(path.join(SHELL, "node_modules", "js-yaml"));
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blave-updsig-"));
const FEED = "https://download.blave.org/desktop/win";
const kp = () => crypto.generateKeyPairSync("ed25519");
const A = kp(), B = kp();
const pubA = sig.publicKeyB64(A.publicKey), pubB = sig.publicKeyB64(B.publicKey);
const sha = (buf) => crypto.createHash("sha512").update(buf).digest("base64");
const manifest = (o = {}) => {
  const version = o.version || "0.1.13", sha512 = o.sha512 || sha(Buffer.from("installer")), feed = o.signFeed || FEED;
  const info = { version, files: [{ url: `Blave-Setup-${version}.exe`, sha512, size: 9 }], path: `Blave-Setup-${version}.exe`, sha512, releaseDate: "2026-10-03T00:00:00.000Z" };
  info.blaveSignature = sig.signManifest(o.key || A.privateKey, { feed, version: o.signVersion || version, sha512: o.signSha || sha512 });
  return info;
};
const V = (info, o = {}) => sig.verifyManifest(info, { keys: o.keys || [pubA], feed: o.feed || FEED, currentVersion: o.current || "0.1.12" });

(async () => {
  // ── 1. updatesig:簽與驗 ──
  t("keysProblem:空陣列 / 不是陣列 / 亂碼 / RSA 公鑰 都不能用;Ed25519 SPKI 可以",
    !!sig.keysProblem([]) && !!sig.keysProblem(null) && !!sig.keysProblem(["bm90IGEga2V5"]) && !!sig.keysProblem([1])
    && !!sig.keysProblem([crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "der", type: "spki" }).toString("base64")])
    && sig.keysProblem([pubA]) === null && sig.keysProblem([pubA, pubB]) === null);
  const good = manifest();
  t("正常簽章:驗得過,回傳簽過的 sha512", V(good).sha512 === good.sha512 && !V(good).error);
  t("更新網址結尾多一個 / 也是同一條軌", !V(good, { feed: FEED + "/" }).error);
  t("換鑰:update-keys.json 有兩把,第二把簽的也收", !V(manifest({ key: B.privateKey }), { keys: [pubA, pubB] }).error);
  const bad = {
    "沒有簽章": (() => { const m = manifest(); delete m.blaveSignature; return m; })(),
    "簽章是空字串": { ...manifest(), blaveSignature: "" },
    "別把鑰匙簽的(偽造 yml)": manifest({ key: B.privateKey }),
    "簽章亂碼": { ...manifest(), blaveSignature: "AAAA" },
    "改 sha(頂層與 files 一起換成別的安裝檔)": (() => { const m = manifest(), s = sha(Buffer.from("evil")); m.sha512 = s; m.files[0].sha512 = s; return m; })(),
    "只改頂層 sha512": { ...manifest(), sha512: sha(Buffer.from("evil")) },
    "files 多一筆不同 sha 的(electron-updater 可能挑到它)": (() => { const m = manifest(); m.files.push({ url: "Blave-Setup-x64.exe", sha512: sha(Buffer.from("evil")) }); return m; })(),
    "files 那筆只有 sha2": (() => { const m = manifest(); m.files = [{ url: m.path, sha2: "abc" }]; return m; })(),
    "files 是空的": { ...manifest(), files: [] },
    "帶 packages(web installer 的 7z 不經過驗章)": { ...manifest(), packages: { x64: { path: "p.7z", sha512: "x" } } },
    "改版號(簽的是 0.1.13,yml 寫 9.9.9)": { ...manifest(), version: "9.9.9" },
    "降版:合法簽過的 0.1.11 給 0.1.12 的 app": manifest({ version: "0.1.11" }),
    "同版:0.1.12 給 0.1.12": manifest({ version: "0.1.12" }),
    "版號不是 A.B.C": manifest({ version: "0.1.13-beta.1" }),
    "換軌重放:win-test 簽的那份放到 win": manifest({ signFeed: "https://download.blave.org/desktop/win-test" }),
    "沒有 info": null,
  };
  for (const [name, info] of Object.entries(bad)) t("驗不過:" + name, !!V(info).error && !V(info).sha512);
  t("降版那筆的簽章本身是對的(擋它的是版號比較,不是簽章)", !V(manifest({ version: "0.1.11" }), { current: "0.1.10" }).error);
  t("newer:逐段比數字(0.1.10 > 0.1.9;不是字串比)", sig.newer("0.1.10", "0.1.9") && !sig.newer("0.1.9", "0.1.10") && !sig.newer("0.1.9", "0.1.9") && !sig.newer("x", "0.1.0"));
  const blob = path.join(TMP, "blob.bin"); fs.writeFileSync(blob, crypto.randomBytes(300000));
  t("sha512File(串流)= 整檔 sha512(base64,跟 latest.yml 同格式)", (await sig.sha512File(blob)) === sha(fs.readFileSync(blob)));

  // ── 2. updater.js 的掛點(假的 autoUpdater,形狀照 NsisUpdater)──
  function fakeNsis() {
    const au = new EventEmitter(); au.calls = []; au.authenticode = [];
    au.setFeedURL = (o) => au.calls.push(["feed", o]); au.checkForUpdates = () => { au.calls.push(["check"]); return Promise.resolve(); };
    au.quitAndInstall = (...a) => au.calls.push(["install", ...a]);
    au.verifySignature = async function (file) { au.authenticode.push(file); return null; };
    return au;
  }
  let states = [], logs = [], fails = [];
  const mk = (extra = {}) => { const au = extra.au || fakeNsis(); states = []; logs = []; fails = [];
    return { au, up: createUpdater({ autoUpdater: au, nativeUpdater: null, feedUrl: FEED, currentVersion: "0.1.12", isTrading: () => false, onState: (s) => states.push(s), setTimer: () => 0, log: (m) => logs.push(m), onFail: (s) => fails.push(s), signed: { keys: [pubA] }, ...extra }) }; };
  let { au, up } = mk({ signed: { keys: [] } });
  t("win32 沒有公鑰:start 不做事(不設來源、不查)、phase=off、有記 log;check 也不查", up.start() === false && up.state().phase === "off" && !au.calls.length && logs.some((l) => /updates disabled/.test(l)) && up.check() === false);
  ({ au, up } = mk({ au: (() => { const a = fakeNsis(); delete a.verifySignature; return a; })() }));
  t("electron-updater 沒有 verifySignature 可掛(升版改了內部):不更新,不退回只比 sha512", up.start() === false && up.state().phase === "off" && !au.calls.length);
  ({ au, up } = mk());
  const orig = au.verifySignature;
  t("start:掛上自己的驗章、關掉 web installer、設好來源", up.start() === true && au.verifySignature !== orig && au.disableWebInstaller === true && au.calls[0][0] === "feed");
  const exe = path.join(TMP, "temp-Blave-Setup-0.1.13.exe"); fs.writeFileSync(exe, crypto.randomBytes(200000));
  const real = manifest({ sha512: sha(fs.readFileSync(exe)) });
  au.emit("update-available", real);
  t("下載完的檔 sha512 = 簽過的:放行,而且原本那支(Authenticode)照叫", (await au.verifySignature(exe)) === null && au.authenticode.length === 1);
  fs.appendFileSync(exe, "x");
  const r1 = await au.verifySignature(exe);
  t("檔案被換(sha512 對不上簽過的):回錯誤字串(electron-updater 會刪檔、不暫存),不叫 Authenticode", typeof r1 === "string" && au.authenticode.length === 1 && logs.some((l) => /sha512 differs/.test(l)));
  for (const [name, info] of [["沒簽章", (() => { const m = { ...real }; delete m.blaveSignature; return m; })()], ["偽造", manifest({ key: B.privateKey, sha512: real.sha512 })], ["降版", manifest({ version: "0.1.11", sha512: real.sha512 })], ["改 sha", { ...real, sha512: sha(Buffer.from("e")), files: [{ url: "x.exe", sha512: sha(Buffer.from("e")) }] }]]) {
    au.emit("update-available", info);
    t("掛點:" + name + " → 不放行", typeof (await au.verifySignature(exe)) === "string");
  }
  au.emit("update-available", real);
  t("掛點裡出例外(檔案不見)也只回字串,不往外丟", typeof (await au.verifySignature(path.join(TMP, "nope.exe"))) === "string");
  // 快取路徑:electron-updater 不重新下載就不走 verifySignature,靠 update-downloaded 那一道
  ({ au, up } = mk()); up.start(); au.autoInstallOnAppQuit = true;
  au.emit("update-downloaded", { ...manifest({ key: B.privateKey }), downloadedFile: exe });
  t("update-downloaded 的 yml 驗不過:autoInstallOnAppQuit 當場關掉、phase=error、安裝鈕拒絕、記 update_failed(download)",
    au.autoInstallOnAppQuit === false && up.state().phase === "error" && up.state().error === "UPDATE_FAILED" && up.install().error === "NOT_READY" && fails.join() === "download" && !au.calls.some((c) => c[0] === "install"));
  au.emit("update-downloaded", { ...manifest(), downloadedFile: exe });
  t("同一個 session 之後來了正確簽章的:autoInstallOnAppQuit 打開、ready、可以裝", au.autoInstallOnAppQuit === true && up.state().phase === "ready" && up.install().ok === true);
  ({ au, up } = mk({ signed: null })); const o2 = au.verifySignature; up.start(); au.emit("update-downloaded", { version: "0.1.13" });
  t("mac(signed=null):不掛驗章、不碰 web installer,update-downloaded 照舊", au.verifySignature === o2 && au.disableWebInstaller === undefined && up.state().phase === "ready");
  { const a = fakeNsis(); let rejected = null; const p = Promise.reject(new Error("ERR_UPDATER_INVALID_SIGNATURE")); a.checkForUpdates = () => Promise.resolve({ downloadPromise: p });
    const onRej = (e) => { rejected = e; }; process.on("unhandledRejection", onRej);
    ({ up } = mk({ au: a })); up.start(); up.check(); await tick(); await tick(); process.off("unhandledRejection", onRej);
    t("下載被擋(downloadPromise reject):接住,不留 unhandled rejection", rejected === null); }

  // ── 3. 真的 electron-updater NsisUpdater:本機 HTTP 跑查 → 下載 → 驗 → 暫存 ──
  const { NsisUpdater } = require(path.join(SHELL, "node_modules", "electron-updater", "out", "NsisUpdater.js"));
  const BU = require(path.join(SHELL, "node_modules", "builder-util-runtime"));
  // 同 electronHttpExecutor.js 的 download,只是請求走 node http(測試裡沒有 electron.net)
  class NodeHttp extends BU.HttpExecutor {
    createRequest(o, cb) { const r = http.request(o); r.on("response", cb); return r; }
    download(url, destination, options) {
      return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
        const ro = { headers: options.headers || undefined, redirect: "manual" };
        BU.configureRequestUrl(url, ro); BU.configureRequestOptions(ro);
        this.doDownload(ro, { destination, options, onCancel, callback: (e) => (e == null ? resolve(destination) : reject(e)), responseHandler: null }, 0);
      });
    }
  }
  const files = {};
  const srv = http.createServer((q, s) => { const f = files[decodeURIComponent(q.url.split("?")[0])]; if (!f) { s.statusCode = 404; return s.end(); } s.setHeader("content-length", f.length); s.setHeader("connection", "close"); s.end(f); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const LFEED = `http://127.0.0.1:${srv.address().port}/desktop/win`;
  const installer = crypto.randomBytes(256 * 1024), evil = crypto.randomBytes(256 * 1024);
  const keysFile = path.join(TMP, "update-keys.json"); fs.writeFileSync(keysFile, "[]\n");
  const keyPath = path.join(TMP, "cfg", "update.pem");
  const kg = signer.keygen(keyPath, keysFile), keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const priv = signer.loadSigningKey(keyPath, keys);
  const ymlFor = (ver, buf) => `version: ${ver}\nfiles:\n  - url: Blave-Setup-${ver}.exe\n    sha512: ${sha(buf)}\n    size: ${buf.length}\npath: Blave-Setup-${ver}.exe\nsha512: ${sha(buf)}\nreleaseDate: '2026-10-03T00:00:00.000Z'\n`;
  const signedYml = (ver, buf) => signer.signYml({ ymlText: ymlFor(ver, buf), version: ver, feed: LFEED, privateKey: priv, keys, exeSha512: sha(buf), liveVersion: "0.1.12", first: false }).signedText;
  let run = 0;
  async function realRun(yml, exeBuf, o = {}) {
    run++;
    const dir = path.join(TMP, "real-" + (o.reuse || run)); fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, "app-update.yml"); fs.writeFileSync(cfg, `provider: generic\nurl: ${LFEED}\nupdaterCacheDirName: blave-updater\n`);
    let quitHandlers = 0;
    const appA = { version: "0.1.12", name: "Blave", isPackaged: true, appUpdateConfigPath: cfg, userDataPath: dir, baseCachePath: dir, whenReady: () => Promise.resolve(), quit() {}, relaunch() {}, onQuit() { quitHandlers++; } };
    files["/desktop/win/latest.yml"] = Buffer.from(yml); files["/desktop/win/Blave-Setup-0.1.13.exe"] = exeBuf;
    const nu = new NsisUpdater(null, appA); nu.httpExecutor = new NodeHttp(); nu.logger = null;
    nu._testOnlyOptions = { platform: "win32", isUseDifferentialDownload: false }; nu.disableDifferentialDownload = true;
    const st = []; const lg = [];
    const u = createUpdater({ autoUpdater: nu, nativeUpdater: null, feedUrl: LFEED, currentVersion: "0.1.12", isTrading: () => false, onState: (s) => st.push(s.phase), setTimer: () => 0, log: (m) => lg.push(m), signed: { keys } });
    u.start(); u.check();
    for (let i = 0; i < 400 && !["ready", "error", "idle"].includes(u.state().phase); i++) await new Promise((r) => setTimeout(r, 10));
    const pending = path.join(dir, "blave-updater", "pending");
    const staged = fs.existsSync(pending) ? fs.readdirSync(pending).filter((f) => f.endsWith(".exe")) : [];
    return { phase: u.state().phase, auto: nu.autoInstallOnAppQuit, quitHandlers, staged, log: lg, u };
  }
  let R = await realRun(signedYml("0.1.13", installer), installer);
  t("真 NsisUpdater:sign-update.js 簽的 yml + 對的安裝檔 → 下載、驗過、暫存、ready、結束時會裝", R.phase === "ready" && R.auto === true && R.quitHandlers === 1 && R.staged.length === 1 && !R.log.length);
  if (R.phase !== "ready") console.log("      ", JSON.stringify(R.log), R.phase);
  t("keygen:私鑰 0600、公鑰寫進 keys 檔", (fs.statSync(keyPath).mode & 0o777) === 0o600 && keys.length === 1 && keys[0] === kg.pub);
  // 每一筆都要確認是被「該擋它的那一道」擋下(看 log),不是別的原因失敗——不然這段測試是空的
  const REJ = /update rejected: manifest/, SHA = /sha512 checksum mismatch/i;
  const cases = {
    "yml 沒簽章(現在 CI 產的那種)": [ymlFor("0.1.13", installer), installer, /update rejected: manifest is not signed/],
    "安裝檔被換、yml 的 sha 也跟著改(能寫 S3 的人做得到的)": [ymlFor("0.1.13", evil), evil, REJ],
    "簽好的 yml 不動、只換安裝檔(electron-updater 自己的 sha512 先擋)": [signedYml("0.1.13", installer), evil, SHA],
    "簽好的 yml 只改 sha512 行": [signedYml("0.1.13", installer).split(sha(installer)).join(sha(evil)), evil, /update rejected: manifest signature does not verify/],
    "簽好的 yml 只改版號": [signedYml("0.1.13", installer).replace("version: 0.1.13", "version: 0.1.14").replace(/0\.1\.13\.exe/g, "0.1.14.exe"), installer, /update rejected: manifest signature does not verify/],
    "別把鑰匙簽的": [ymlFor("0.1.13", installer) + `blaveSignature: ${sig.signManifest(B.privateKey, { feed: LFEED, version: "0.1.13", sha512: sha(installer) })}\n`, installer, /update rejected: manifest signature does not verify/],
  };
  files["/desktop/win/Blave-Setup-0.1.14.exe"] = installer;
  for (const [name, [yml, buf, why]] of Object.entries(cases)) {
    R = await realRun(yml, buf);
    const ok = R.phase === "error" && R.staged.length === 0 && R.quitHandlers === 0 && R.log.some((l) => why.test(l));
    t("真 NsisUpdater 不裝:" + name + " → error、沒暫存、沒掛結束時安裝(log:" + why.source + ")", ok); if (!ok) console.log("      ", JSON.stringify(R.log), R.phase);
  }
  { // 降版:合法簽過的舊版 yml。electron-updater 自己就判 not-available;我們的版號檢查是第二道(上面第 1、2 段)
    files["/desktop/win/Blave-Setup-0.1.11.exe"] = installer;
    R = await realRun(signer.signYml({ ymlText: ymlFor("0.1.11", installer), version: "0.1.11", feed: LFEED, privateKey: priv, keys, exeSha512: sha(installer), liveVersion: null, first: true }).signedText, installer);
    t("真 NsisUpdater:降版(合法簽過的 0.1.11)→ electron-updater 判沒有新版(idle)、不下載、不暫存", R.phase === "idle" && R.staged.length === 0 && R.quitHandlers === 0); }
  { // 快取路徑:先正常下載一次留在 pending/,再換成「同 sha512、簽章壞掉」的 yml——electron-updater 用快取、不走 verifySignature
    R = await realRun(signedYml("0.1.13", installer), installer, { reuse: "cache" });
    const first = R.phase === "ready" && R.staged.length === 1;
    R = await realRun(ymlFor("0.1.13", installer) + `blaveSignature: ${sig.signManifest(B.privateKey, { feed: LFEED, version: "0.1.13", sha512: sha(installer) })}\n`, installer, { reuse: "cache" });
    t("真 NsisUpdater 快取路徑:pending/ 已有同 sha 的檔、yml 簽章壞掉 → 不走 verifySignature(證明快取路徑存在),由 update-downloaded 那道擋下(error、不掛結束時安裝)", first && R.phase === "error" && R.auto === false && R.quitHandlers === 0 && R.log.some((l) => /downloaded update rejected/.test(l)) && !R.log.some((l) => /^update rejected/.test(l)));
    if (!(R.phase === "error")) console.log("      ", first, JSON.stringify(R.log), R.phase); }
  srv.close();

  // ── 4. sign-update.js ──
  const base = { ymlText: ymlFor("0.1.13", installer), version: "0.1.13", feed: FEED, privateKey: priv, keys, exeSha512: sha(installer), liveVersion: "0.1.12", first: false };
  const throws = (o, re) => { try { signer.signYml({ ...base, ...o }); return false; } catch (e) { return re.test(e.message); } };
  const out = signer.signYml(base), parsed = yaml.load(out.signedText);
  t("signYml:原文不動、最後多一行 blaveSignature;用 app 的 verifyManifest 驗得過", out.signedText.startsWith(base.ymlText) && /\nblaveSignature: \S+\n$/.test(out.signedText) && !sig.verifyManifest(parsed, { keys, feed: FEED, currentVersion: "0.1.12" }).error && out.exe === "Blave-Setup-0.1.13.exe");
  t("signYml 拒絕:已經簽過", throws({ ymlText: out.signedText }, /已經帶簽章/));
  t("signYml 拒絕:yml 版號跟要發的不同", throws({ version: "0.1.14" }, /版號/));
  t("signYml 拒絕:正式網址上的 exe 跟 yml 的 sha 不同", throws({ exeSha512: sha(evil) }, /對不上/));
  t("signYml 拒絕:線上已經是同版或更新", throws({ liveVersion: "0.1.13" }, /沒有比它大/) && throws({ liveVersion: "0.2.0" }, /沒有比它大/));
  t("signYml 拒絕:讀不到線上又沒說 --first-release;線上有卻說 --first-release", throws({ liveVersion: null }, /first-release/) && throws({ first: true }, /first-release/));
  t("signYml 拒絕:files[] 指到別的檔名", throws({ ymlText: base.ymlText.replace("url: Blave-Setup-0.1.13.exe", "url: other.exe") }, /files/));
  t("signYml 拒絕:yml 的 files 跟頂層 sha 不一致(自己驗一次就擋下)", throws({ ymlText: base.ymlText.replace(/(files:\n  - url: \S+\n    sha512: )\S+/, "$1" + sha(evil)) }, /驗不過/));
  t("loadSigningKey 拒絕:公鑰不在 update-keys.json(會讓全體更新卡死的那把)", (() => { try { signer.loadSigningKey(keyPath, [pubA]); return false; } catch (e) { return /不在 update-keys\.json/.test(e.message); } })());
  fs.chmodSync(keyPath, 0o644);
  t("loadSigningKey 拒絕:私鑰檔權限太寬", (() => { try { signer.loadSigningKey(keyPath, keys); return false; } catch (e) { return /chmod 600/.test(e.message); } })());
  t("keygen 不覆寫已存在的私鑰", (() => { try { signer.keygen(keyPath, keysFile); return false; } catch (e) { return /不覆寫/.test(e.message); } })());

  // ── 5. 釘死的前提(electron-updater 升版、打包、CI 改形狀時會紅)──
  const nsisSrc = fs.readFileSync(path.join(SHELL, "node_modules", "electron-updater", "out", "NsisUpdater.js"), "utf8");
  const baseSrc = fs.readFileSync(path.join(SHELL, "node_modules", "electron-updater", "out", "BaseUpdater.js"), "utf8");
  const dl = nsisSrc.slice(nsisSrc.indexOf("doDownloadUpdate("), nsisSrc.indexOf("async verifySignature("));
  t("electron-updater 釘死 6.8.9(掛點是內部方法)", require(path.join(SHELL, "package.json")).dependencies["electron-updater"] === "6.8.9");
  t("NsisUpdater:下載完在暫存前叫 this.verifySignature(暫存檔),回字串就刪檔丟 ERR_UPDATER_INVALID_SIGNATURE",
    /const signatureVerificationStatus = await this\.verifySignature\(destinationFile\);\s*if \(signatureVerificationStatus != null\) \{\s*await removeTempDirIfAny\(\);[\s\S]{0,400}ERR_UPDATER_INVALID_SIGNATURE/.test(dl));
  t("BaseUpdater:先發 update-downloaded 再掛結束時安裝(update-downloaded 裡同步關 autoInstallOnAppQuit 才有用)", /this\.dispatchUpdateDownloaded\(event\);\s*this\.addQuitHandler\(\);/.test(baseSrc) && /if \(this\.quitHandlerAdded \|\| !this\.autoInstallOnAppQuit\) \{\s*return;/.test(baseSrc));
  const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), cfgSrc = fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8");
  t("main.js:只有 win32 打開簽章驗證,公鑰從 update-keys.json 讀", /signed: feedUrl && process\.platform === "win32" \? \{ keys: require\("\.\/update-keys\.json"\) \} : null,/.test(mainSrc));
  t("打包:updatesig.js 與 update-keys.json 在 files 白名單", /files:\s*\[[^\]]*"updatesig\.js"/.test(cfgSrc) && /files:\s*\[[^\]]*"update-keys\.json"/.test(cfgSrc));
  { const sp = (env) => cp.spawnSync(process.execPath, ["-e", "require(process.argv[1])", path.join(SHELL, "electron-builder.config.js"), "--win", "nsis", "--x64"], { encoding: "utf8", env: { ...process.env, BLAVE_MAC_IDENTITY: "", BLAVE_RELEASE: "", BLAVE_UPDATE_URL: "", BLAVE_WIN_PUBLISHER: "", APPLE_API_KEY: "", ...env } });
    const repoKeys = JSON.parse(fs.readFileSync(path.join(SHELL, "update-keys.json"), "utf8"));
    const withUrl = sp({ BLAVE_UPDATE_URL: "https://download.blave.org/desktop/win-test" }), noUrl = sp({});
    t("打包閘門:帶更新來源的 win 包,update-keys.json 不能用就 throw(現在 repo 裡的那份:" + (sig.keysProblem(repoKeys) || "可用") + ")",
      sig.keysProblem(repoKeys) ? /update-keys\.json 不能用/.test(withUrl.stderr) && withUrl.status !== 0 : withUrl.status === 0);
    t("打包閘門:不帶更新來源的 pack:win 不受影響", noUrl.status === 0); }
  const wf = yaml.load(fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "desktop-win.yml"), "utf8"));
  const buildJ = JSON.stringify(wf.jobs.build), stageJ = wf.jobs.stage, stageS = JSON.stringify(stageJ);
  t("CI build job:沒有任何 secrets、沒有 AWS、沒有 id-token(npm ci 在這裡跑)", !/secrets\./.test(buildJ) && !/aws/i.test(buildJ) && !/id-token/.test(buildJ));
  t("CI stage job:環境 desktop-release(要核准)、OIDC role、不 checkout、不跑 npm/node", stageJ.environment === "desktop-release" && stageJ.permissions["id-token"] === "write" && /role-to-assume/.test(stageS) && !/aws-access-key-id|aws-secret-access-key/.test(stageS) && !stageJ.steps.some((x) => /checkout|setup-node/.test(x.uses || "")) && !/npm (ci|install)|npx /.test(stageS));
  t("整個 workflow 只能把 yml 傳到 staging/,碰不到對外的 latest.yml 與固定檔名 Blave-Setup.exe", /\$PREFIX\/staging\/\$VER\/latest\.yml/.test(stageS) && !/\$PREFIX\/latest\.yml/.test(JSON.stringify(wf)) && !/\$PREFIX\/Blave-Setup\.exe/.test(JSON.stringify(wf)) && !/aws-access-key-id/.test(JSON.stringify(wf)));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
