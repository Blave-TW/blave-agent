// 統一本機開通的主行程這一側(shell/president_local.js)+ daemon.js 的 president_local 那道閘。不起 Electron、不連網、不碰統一。
//   1. 封裝:sealFor 用 daemon secret 衍生的 AES-GCM,換一把 secret 打不開;密文裡找不到明文
//   2. 存:帳密只經 safeStorage(假的那份)落地,檔裡沒有明文;壞帳號 / 有換行的密碼不存;換帳號就丟掉舊的憑證密碼
//   3. 找憑證:只看 PSCCA 那一層的 .pfx(子資料夾、連結、別的副檔名不算),回給畫面的只有張數 / 到期日 / 時間,沒有檔名
//   4. 選好憑證:送 president_local cert,封包裡是存著的帳密 + 這次的憑證密碼 + 那張的路徑、live=true;成功才存憑證密碼
//   5. daemon 剛起來(secrets=false)才補交,30 秒內不重送;.env 沒綁統一不送
//   6. 憑證e總管:雜湊對不上 / 下載不到 → 不執行、改開憑證中心;對上才以一般權限打開(detached);不是 Windows 不做
//   7. daemon.js:president_local 只有主行程(trusted)送得出,形狀不對擋;renderer 解得了統一的五行
//   8. 部位口數、測試段出口回 NOT_READY(TODO president-testhost-018)
// 跑法:node tests/check_shell_president_local.js
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const P = require("../shell/president_local");
const D = require("../shell/daemon");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pres-local-")), ud = path.join(tmp, "ud"), home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "PSCCA", "sub"), { recursive: true });
  const SECRET = "a".repeat(64);
  // 1. 封裝
  const open = (blob, secret) => {
    const raw = Buffer.from(blob, "base64"), key = crypto.createHmac("sha256", secret).update("president-local-seal-v1").digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); d.setAAD(Buffer.from("president-local-v1"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
  };
  const blob = P.sealFor(SECRET, { password: "trade-pw-123" });
  ok("1 封裝:同一把 secret 打得開", open(blob, SECRET).password === "trade-pw-123");
  let other = null; try { open(blob, "b".repeat(64)); } catch (_) { other = "refused"; }
  ok("1 換一把 secret 打不開", other === "refused");
  ok("1 密文裡沒有明文", !Buffer.from(blob, "base64").toString("latin1").includes("trade-pw-123"));

  // 2. 存
  const fakeSeal = { available: () => true, encrypt: (v) => Buffer.from("SEALED:" + Buffer.from(v).toString("base64")), decrypt: (b) => Buffer.from(String(b).slice(7), "base64").toString() };
  const sent = [];
  let reply = { ok: true, result: { cert: { not_after: "2027-09-30T00:00:00Z" } } };
  const host = { send: async (cmd, args, o) => { sent.push({ cmd, args, o }); return reply; }, sealPresident: (obj) => P.sealFor(SECRET, obj) };
  const spawned = [], opened = [];
  let fetched = null, pickRet = null;
  const pres = P.createPresident({ userData: ud, home, platform: "win32", seal: fakeSeal, host: () => host, pickFile: async () => pickRet,
    fetchBuffer: async () => fetched, spawnFn: (exe, argv, o) => { spawned.push({ exe, o }); return { on() {}, unref() {} }; }, openExternal: (u) => opened.push(u) });
  ok("2 壞帳號不存", pres.saveCreds({ account: "1234", password: "x" }).code === "BAD_ACCOUNT" && !fs.existsSync(path.join(ud, "president.bin")));
  ok("2 有換行的密碼不存", pres.saveCreds({ account: "70000011234", password: "a\nb" }).code === "BAD_PW");
  ok("2 存:只經 safeStorage", pres.saveCreds({ account: "70000011234", password: "trade-pw-123" }).code === "OK"
    && !fs.readFileSync(path.join(ud, "president.bin"), "utf8").includes("trade-pw-123"));
  ok("2 畫面拿得到的只有帳號與狀態", JSON.stringify(pres.info()) === JSON.stringify({ saved: true, account: "70000011234", certSaved: false, windows: true, pickedOther: false }));
  const noSeal = P.createPresident({ userData: path.join(tmp, "ud2"), home, platform: "win32", seal: { available: () => false }, host: () => host, pickFile: async () => null });
  ok("2 加密儲存不能用 → NO_SEAL,不落地", noSeal.saveCreds({ account: "70000011234", password: "x" }).code === "NO_SEAL" && !fs.existsSync(path.join(tmp, "ud2", "president.bin")));

  // 3. 找憑證
  const name1 = "PSC_A123456789_20270930.pfx", name2 = "PSC_A123456789_20260101.pfx";
  fs.writeFileSync(path.join(home, "PSCCA", name2), "old"); fs.utimesSync(path.join(home, "PSCCA", name2), new Date(2000, 1, 1), new Date(2000, 1, 1));
  fs.writeFileSync(path.join(home, "PSCCA", name1), "new");
  fs.writeFileSync(path.join(home, "PSCCA", "readme.txt"), "x"); fs.writeFileSync(path.join(home, "PSCCA", "sub", "deep.pfx"), "x");
  try { fs.symlinkSync(path.join(home, "PSCCA", name1), path.join(home, "PSCCA", "link.pfx")); } catch (_) { }
  const sc = pres.scan();
  ok("3 只算那一層的 .pfx(子資料夾、連結、別的副檔名不算)", sc.code === "OK" && sc.found === 2, sc);
  ok("3 最新那張的到期日(讀檔名尾的 8 碼)", sc.expiry === "2027/09/30", sc);
  ok("3 回給畫面的沒有檔名", !JSON.stringify(sc).includes("A123456789") && !JSON.stringify(sc).includes(".pfx"));
  ok("3 檔名不像日期 → 不講到期日", P.expiryFromName("PSC_x_20271340.pfx") === null && P.expiryFromName("x.pfx") === null);
  const mac = P.createPresident({ userData: ud, home, platform: "darwin", seal: fakeSeal, host: () => host, pickFile: async () => null });
  ok("3 不是 Windows → NOT_WINDOWS", mac.scan().code === "NOT_WINDOWS");

  // 4. 選好憑證
  const r4 = await pres.certUse({ caPassword: "ca-pw", source: "found" });
  const c4 = sent[sent.length - 1], b4 = open(c4.args.sealed, SECRET);
  ok("4 送 president_local cert(主行程那條)", r4.code === "OK" && c4.cmd === "president_local" && c4.args.op === "cert" && c4.o.trusted === true);
  ok("4 封包:存著的帳密 + 這次的憑證密碼 + 最新那張的路徑 + live", b4.account === "70000011234" && b4.password === "trade-pw-123" && b4.ca_password === "ca-pw"
    && b4.src === path.join(home, "PSCCA", name1) && b4.live === true, Object.assign({}, b4, { password: "•" }));
  ok("4 指令本身沒有明文", !JSON.stringify(c4.args).includes("trade-pw-123") && !JSON.stringify(c4.args).includes("A123456789"));
  ok("4 成功才存憑證密碼", pres.info().certSaved === true && pres._load().ca_password === "ca-pw");
  reply = { ok: false, error: "ValueError: PFX_PASSWORD: the certificate password does not open this file" };
  const r4b = await pres.certUse({ caPassword: "nope", source: "found" });
  ok("4 失敗回機器的代號,存著的憑證密碼不變", r4b.code === "PFX_PASSWORD" && pres._load().ca_password === "ca-pw", r4b);
  reply = { ok: true, result: {} };
  await pres.certUse({ caPassword: null, source: "found" });
  ok("4 null = 沿用存著的憑證密碼(改交易密碼後重綁)", open(sent[sent.length - 1].args.sealed, SECRET).ca_password === "ca-pw");
  pickRet = path.join(tmp, "elsewhere", "mine.pfx");
  ok("4 選別的檔案:路徑只留在主行程", (await pres.pickOther()).code === "OK" && pres.info().pickedOther === true);
  await pres.certUse({ caPassword: "ca-pw", source: "picked" });
  ok("4 …送出的是那一張", open(sent[sent.length - 1].args.sealed, SECRET).src === pickRet);
  pickRet = "relative.pfx";
  ok("4 相對路徑 / 不是 .pfx 不收", (await pres.pickOther()).code === "BAD_FILE");
  pres.saveCreds({ account: "70000099999", password: "p2" });
  ok("4 換帳號:舊的憑證密碼丟掉(要重選憑證)", pres._load().ca_password === undefined);
  pres.saveCreds({ account: "70000011234", password: "trade-pw-123" });
  reply = { ok: true, result: {} }; await pres.certUse({ caPassword: "ca-pw", source: "found" });
  reply = { ok: false, error: "UNKNOWN_RESULT" };
  ok("4 長步驟 daemon 收走了、回條還沒來 → SENT(畫面看狀態)", (await pres.step("probe")).code === "SENT");
  reply = { ok: true, result: {} };
  await pres.step("probe", { afterUnlock: true });
  ok("4 我已解鎖 → probe {after_unlock:true}", JSON.stringify(sent[sent.length - 1].args) === JSON.stringify({ op: "probe", after_unlock: true }));
  ok("4 step 不收 cert / secrets / 亂的名字", (await pres.step("cert")).code === "BAD_ARGS" && (await pres.step("secrets")).code === "BAD_ARGS" && (await pres.step("rm")).code === "BAD_ARGS");

  // 5. 補交
  const n0 = sent.length, rep = (secrets, bound) => ({ president_local: { secrets }, venues: bound ? { president: { credentials: true } } : {} });
  await pres.resync(rep(true, true)); await pres.resync(rep(false, false));
  ok("5 已經有了 / .env 沒綁統一 → 不送", sent.length === n0);
  await pres.resync(rep(false, true));
  const s5 = sent[sent.length - 1];
  ok("5 daemon 空手 → 補交 secrets(封裝)", sent.length === n0 + 1 && s5.args.op === "secrets" && open(s5.args.sealed, SECRET).password === "trade-pw-123");
  await pres.resync(rep(false, true));
  ok("5 30 秒內不重送", sent.length === n0 + 1);

  // 6. 憑證e總管
  fetched = Buffer.from("not the official exe");
  const r6 = await pres.openTcem();
  ok("6 雜湊對不上 → HASH,不執行,改開憑證中心", r6.code === "HASH" && spawned.length === 0 && opened[opened.length - 1] === P.CERT_CENTER_URL
    && !fs.existsSync(path.join(ud, "president", "TCEM.exe")));
  fetched = null;
  const pres2 = P.createPresident({ userData: ud, home, platform: "win32", seal: fakeSeal, host: () => host, pickFile: async () => null,
    fetchBuffer: async () => { throw new Error("offline"); }, spawnFn: (exe, argv, o) => { spawned.push({ exe, o }); return { on() {}, unref() {} }; }, openExternal: (u) => opened.push(u) });
  ok("6 下載不到 → DOWNLOAD,不執行", (await pres2.openTcem()).code === "DOWNLOAD" && spawned.length === 0);
  // 對得上的那份:改常數不改程式(雜湊是官方那一版的,這裡用一份假檔驗流程)
  const fake = Buffer.from("official-ish"), mod = require("module");
  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "president_local.js"), "utf8").replace(P.TCEM_SHA256, crypto.createHash("sha256").update(fake).digest("hex"));
  const m = new mod(path.join(__dirname, "..", "shell", "president_local.js")); m.paths = mod._nodeModulePaths(path.join(__dirname, "..", "shell")); m._compile(src, m.id);
  const pres3 = m.exports.createPresident({ userData: ud, home, platform: "win32", seal: fakeSeal, host: () => host, pickFile: async () => null,
    fetchBuffer: async () => fake, spawnFn: (exe, argv, o) => { spawned.push({ exe, argv, o }); return { on() {}, unref() {} }; }, openExternal: (u) => opened.push(u) });
  const r6c = await pres3.openTcem();
  ok("6 對上 → 存成 TCEM.exe(檔名不含 setup / install)並以一般權限打開、不等它", r6c.code === "OK" && spawned.length === 1 && spawned[0].exe === path.join(ud, "president", "TCEM.exe")
    && spawned[0].o.detached === true && spawned[0].argv.length === 0 && !/setup|install/i.test(path.basename(spawned[0].exe)), r6c);
  ok("6 不是 Windows 不做", (await mac.openTcem()).code === "NOT_WINDOWS");

  // 7. daemon.js
  ok("7 president_local 是主行程限定(renderer 送不出)", D.MAIN_ONLY_COMMANDS.has("president_local") && !D.UI_COMMANDS.has("president_local"));
  const sealed = P.sealFor(SECRET, { a: 1 });
  ok("7 形狀:cert / secrets 帶密文;probe 只能多 after_unlock:true;其他只有 op", D.argsOk("president_local", { op: "cert", sealed }, true)
    && D.argsOk("president_local", { op: "probe", after_unlock: true }, true) && D.argsOk("president_local", { op: "start" }, true)
    && !D.argsOk("president_local", { op: "cert" }, true) && !D.argsOk("president_local", { op: "cert", sealed: "not base64!" }, true)
    && !D.argsOk("president_local", { op: "probe", after_unlock: false }, true) && !D.argsOk("president_local", { op: "start", x: 1 }, true)
    && !D.argsOk("president_local", { op: "rm" }, true));
  ok("7 renderer 解得了統一的五行(安全方向)", D.argsOk("credentials_remove", { env: D.PRESIDENT_ENV.map((k) => k.toLowerCase()) }, false));
  ok("7 renderer 寫不了統一(綁定只走 cert 步)", !D.argsOk("credentials", { env: { PRESIDENT_ACCOUNT: "70000011234" } }, false)
    && !D.argsOk("credentials", { env: { PRESIDENT_ACCOUNT: "70000011234" } }, true));
  const dh = D.createDaemonHost({ python: "py", script: "x", base: tmp, workspace: tmp, env: {}, spawnFn: () => { throw new Error("no"); } });
  ok("7 daemon 沒在跑 → 沒有封裝金鑰", dh.sealPresident({ a: 1 }) === null);

  // 8.
  ok("8 部位口數:size > 0 才算", P.heldLots({ account: { venues: { president: { positions: { TMF: { size: 1 }, TXF: { size: 2 }, MXF: { size: 0 } } } } } }) === 3
    && P.heldLots({}) === 0 && P.heldLots(null) === 0);
  ok("8 測試段出口:後端定案前回 NOT_READY", (await pres.testStep("probe")).code === "NOT_READY" && (await pres.testStep("x")).code === "BAD_ARGS");
  ok("8 forget:存的帳密刪掉", pres.forget() && !fs.existsSync(path.join(ud, "president.bin")) && pres.info().saved === false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} 紅` : "\n全綠"); process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack)); process.exit(1); });
