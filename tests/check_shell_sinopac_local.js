// 永豐本機開通的主行程這一側(shell/sinopac_local.js)+ daemon.js 的 sinopac_local 那道閘 + 旗標。不起 Electron、不連網、不碰永豐。
//   0. 旗標(兩個視角同一個):main.js 與 trade.js 的 SINOPAC_LOCAL_ON 同值;關著時 IPC 只註冊解除連接,磚、解除名單、幣別都不列永豐
//   1. 封裝:跟 runtime/sinopac_local.open_sealed 同一組 info／AAD／格式;換一把 secret 打不開;密文裡找不到明文
//   2. 存:只經 safeStorage(假的那份)落地;機器說不行就不存;欄位 null = 沿用存著的那一格;畫面拿不回任何值
//   3. bind 封包:api_key／secret_key／person_id／ca_password(一格 = "")／live=true／src;沒選檔、壞身分證不送
//   4. 步驟只收開通清單那四個;daemon 說 needs_secrets 才補交,30 秒內不重送
//   6. 雲端(cloud_sinopac.js):封包是主機一次性公鑰封的整組(含 pfx),KEY_EXPIRED 重要一把只重試一次,步驟對到 sinopac_* 指令
//   5. daemon.js:sinopac_local 只有主行程(trusted)送得出,ops = runtime LOCAL_OPS,形狀不對擋;五行解得掉
// 跑法:node tests/check_shell_sinopac_local.js
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const S = require("../shell/sinopac_local");
const D = require("../shell/daemon");
const SHELL = path.join(__dirname, "..", "shell"), RT = path.join(__dirname, "..", "runtime");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };

(async () => {
  // 0. 旗標
  const mainSrc = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), tradeSrc = fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8");
  const mf = /^const SINOPAC_LOCAL_ON = (true|false);$/m.exec(mainSrc), tf = /^const SINOPAC_LOCAL_ON = (true|false);$/m.exec(tradeSrc);
  ok("0 main.js 與 trade.js 都有 SINOPAC_LOCAL_ON,值相同", !!mf && !!tf && mf[1] === tf[1]);
  ok("0 這一版旗標關著(翻開跟 runtime 期貨閘門同一版)", !!mf && mf[1] === "false");
  { const i = mainSrc.indexOf("  if (SINOPAC_LOCAL_ON) {\n    const spDenied"), j = mainSrc.indexOf("\n  }\n", i);
    const inside = i >= 0 && j > i ? mainSrc.slice(i, j) : "", all = [...mainSrc.matchAll(/handle\("(sinopac-[a-z-]+)"/g)].map((m) => m[1]);
    ok("0 sinopac-* IPC 除了解除連接都在旗標裡註冊", all.length === 9 && all.filter((n) => n !== "sinopac-unbind").every((n) => inside.includes('handle("' + n + '"'))
      && !inside.includes('handle("sinopac-unbind"'), all);
    ok("0 補交輪詢也看旗標", /if \(SINOPAC_LOCAL_ON\) \{ const tm = setInterval\(\(\) => startStep\("sinopac", spSync\), 5000\)/.test(mainSrc)); }
  ok("0 旗標關:磚、解除名單、幣別、顯示名都只在旗標開時列永豐",
    tradeSrc.includes('const sp = SINOPAC_LOCAL_ON ? ["sinopac", "sp.venue"] : null;') && tradeSrc.includes("if (id === \"sinopac\" && SINOPAC_LOCAL_ON) return [\"sinopac_api_key\"")
    && tradeSrc.includes("SINOPAC_LOCAL_ON ? { sinopac: \"TWD\" } : {}") && tradeSrc.includes('if (id === "sinopac" && SINOPAC_LOCAL_ON) return t("sp.venue");')
    && /function trSpWip\(r, id\) \{ return id === "sinopac" && SINOPAC_LOCAL_ON && /.test(tradeSrc) && /function trSpLoginHeld\(r, id\) \{ return id === "sinopac" && SINOPAC_LOCAL_ON && /.test(tradeSrc)
    && /function trSpRetryAt\(r, id\) \{ return id === "sinopac" && SINOPAC_LOCAL_ON && /.test(tradeSrc) && tradeSrc.includes('if (CXF.venue === "sinopac" && SINOPAC_LOCAL_ON) {'));
  ok("0 打包清單有 sinopac_local.js、index.html 載入 sinopac.js", /"sinopac_local\.js"/.test(fs.readFileSync(path.join(SHELL, "electron-builder.config.js"), "utf8"))
    && fs.readFileSync(path.join(SHELL, "renderer", "index.html"), "utf8").includes('<script src="sinopac.js"></script>'));

  // 1. 封裝(= runtime/sinopac_local.py 的常數)
  const rt = fs.readFileSync(path.join(RT, "sinopac_local.py"), "utf8");
  const pyOps = /^LOCAL_OPS = \(([^)]*)\)/m.exec(rt), pyInfo = /^_SEAL_INFO = b"([^"]+)"/m.exec(rt), pyAad = /^_SEAL_AAD = b"([^"]+)"/m.exec(rt);
  ok("1 info／AAD 跟 runtime 同一組", !!pyInfo && !!pyAad && pyInfo[1] === "sinopac-local-seal-v1" && pyAad[1] === "sinopac-local-v1");
  ok("1 ops 跟 runtime LOCAL_OPS 同一組、同順序", !!pyOps && JSON.stringify([...pyOps[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])) === JSON.stringify(S.OPS), pyOps && pyOps[1]);
  const SECRET = "s".repeat(64);
  const open = (blob, secret) => {
    const raw = Buffer.from(blob, "base64"), key = crypto.createHmac("sha256", secret).update("sinopac-local-seal-v1").digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); d.setAAD(Buffer.from("sinopac-local-v1"));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"));
  };
  const blob = S.sealFor(SECRET, { api_key: "not-a-real-key" });
  ok("1 同一把 secret 打得開", open(blob, SECRET).api_key === "not-a-real-key");
  let other = null; try { open(blob, "t".repeat(64)); } catch (_) { other = "refused"; }
  ok("1 換一把 secret 打不開", other === "refused");
  let pres = null; try { const P = require("../shell/president_local"); open(P.sealFor(SECRET, { a: 1 }), SECRET); } catch (_) { pres = "refused"; }
  ok("1 統一的密文在這裡打不開", pres === "refused");
  ok("1 密文裡沒有明文", !Buffer.from(blob, "base64").toString("latin1").includes("not-a-real-key"));

  // 2–4. 主行程
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sp-local-")), ud = path.join(tmp, "ud");
  const pfx = path.join(tmp, "Downloads", "A123456789.pfx"); fs.mkdirSync(path.dirname(pfx), { recursive: true }); fs.writeFileSync(pfx, "not a real pfx");
  const fakeSeal = { available: () => true, encrypt: (v) => Buffer.from("SEALED:" + Buffer.from(v).toString("base64")), decrypt: (b) => Buffer.from(String(b).slice(7), "base64").toString() };
  const sent = []; let reply = { ok: true, result: { cert: { not_after: "2028-10-15T15:59:59Z" } } }, now = 1000000;
  const host = { send: async (cmd, args, o) => { sent.push({ cmd, args, o }); return reply; }, sealSinopac: (obj) => S.sealFor(SECRET, obj) };
  let pickRet = pfx;
  const sp = S.createSinopac({ userData: ud, seal: fakeSeal, host: () => host, pickFile: async () => pickRet, now: () => now });
  const K = "not-a-real-api-key", SK = "not-a-real-secret", ID = "A123456789";
  ok("3 沒選檔不送", (await sp.bind({ apiKey: K, secret: SK, personId: ID, caPassword: "" })).code === "NO_PFX" && sent.length === 0);
  pickRet = path.join(tmp, "x.txt");
  ok("3 選到的不是 .pfx → PFX_INVALID", (await sp.pick()).code === "PFX_INVALID");
  pickRet = null;
  ok("3 取消 → CANCELED", (await sp.pick()).code === "CANCELED");
  pickRet = pfx;
  ok("3 選 .pfx → OK,畫面只知道選了", (await sp.pick()).code === "OK" && JSON.stringify(sp.info()) === JSON.stringify({ saved: false, picked: true, caSeparate: false }));
  ok("3 壞身分證不送", (await sp.bind({ apiKey: K, secret: SK, personId: "A12345", caPassword: "" })).code === "BAD_ID" && sent.length === 0);
  ok("3 金鑰帶空白不送", (await sp.bind({ apiKey: "a b", secret: SK, personId: ID, caPassword: "" })).code === "BAD_KEY" && sent.length === 0);
  reply = { ok: false, error: "Refused: PFX_PASSWORD: the certificate password does not open this file" };
  const bad = await sp.bind({ apiKey: K, secret: SK, personId: "a123456789", caPassword: "" });
  ok("2 機器打不開憑證 → PFX_PASSWORD,什麼都沒存", bad.code === "PFX_PASSWORD" && !fs.existsSync(path.join(ud, "sinopac.bin")));
  const b0 = open(sent[0].args.sealed, SECRET);
  ok("3 bind 封包:身分證轉大寫、一格 = ca_password \"\"、live true、src 是選的那個檔;只有主行程送(trusted)",
    sent[0].cmd === "sinopac_local" && sent[0].args.op === "bind" && Object.keys(sent[0].args).sort().join() === "op,sealed" && sent[0].o.trusted === true
    && JSON.stringify(b0) === JSON.stringify({ api_key: K, secret_key: SK, person_id: ID, ca_password: "", live: true, src: pfx }), b0);
  reply = { ok: true, result: { cert: { not_after: "2028-10-15T15:59:59Z" } } };
  const good = await sp.bind({ apiKey: K, secret: SK, personId: ID, caPassword: "" });
  ok("2 過了才存、回到期日", good.code === "OK" && good.notAfter === "2028-10-15T15:59:59Z" && fs.existsSync(path.join(ud, "sinopac.bin")));
  const disk = fs.readFileSync(path.join(ud, "sinopac.bin"), "utf8");
  ok("2 檔裡沒有明文", !disk.includes(K) && !disk.includes(SK) && !disk.includes(ID));
  ok("2 畫面拿得到的沒有值", JSON.stringify(sp.info()) === JSON.stringify({ saved: true, picked: true, caSeparate: false }));
  sent.length = 0;
  await sp.bind({ apiKey: "not-a-real-key-2", secret: "not-a-real-secret-2", personId: null, caPassword: null });
  const b1 = open(sent[0].args.sealed, SECRET);
  ok("2 〔改金鑰〕:身分證與憑證密碼 null = 沿用存著的", b1.person_id === ID && b1.ca_password === "" && b1.api_key === "not-a-real-key-2" && sp._load().api_key === "not-a-real-key-2");
  ok("3 〔改金鑰〕這一包帶著這次選的檔", b1.src === pfx);
  sp.closeBox(); sent.length = 0;
  ok("2 關框丟掉這次選的檔,存著的那組不動", sp.info().picked === false && sp.info().saved === true);
  await sp.bind({ apiKey: "not-a-real-key-3", secret: "not-a-real-secret-3", personId: null, caPassword: null });
  ok("3 沒選檔、存過 → bind 不帶 src(機器沿用存著的那張,不必重選)", sent.length === 1 && !("src" in open(sent[0].args.sealed, SECRET)));
  reply = { ok: false, error: "Refused: NO_CERT: no certificate stored on this computer — choose the .pfx file" };
  ok("3 機器上沒有那張 → NO_CERT", (await sp.bind({ apiKey: K, secret: SK, personId: null, caPassword: null })).code === "NO_CERT");
  reply = { ok: false, error: "Refused: PFX_EXPIRED: not_after 2026-01-31T15:59:59Z" };
  ok("3 過期:回條的日期帶回畫面", JSON.stringify(await sp.bind({ apiKey: K, secret: SK, personId: null, caPassword: null })) === JSON.stringify({ code: "PFX_EXPIRED", notAfter: "2026-01-31T15:59:59Z" }));
  reply = { ok: true, result: { cert: { not_after: "2028-10-15T15:59:59Z" } } };

  // 4. 步驟與補交
  sent.length = 0; reply = { ok: false, error: "UNKNOWN_RESULT" };
  ok("4 長步驟回條等不到 = SENT;會登入的步驟帶 expect = 存著的那組", (await sp.step("probe")).code === "SENT" && sent[0].args.op === "probe"
    && JSON.stringify(Object.keys(sent[0].args).sort()) === JSON.stringify(["expect", "op"])
    && JSON.stringify(open(sent[0].args.expect, SECRET)) === JSON.stringify({ api_key: "not-a-real-key-3", secret_key: "not-a-real-secret-3", person_id: ID, ca_password: "", live: true }));
  sent.length = 0; await sp.step("setup");
  ok("4 setup 不登入、不帶 expect", JSON.stringify(sent[0].args) === JSON.stringify({ op: "setup" }));
  ok("4 LOGIN_OPS = probe／sim_test／start(= runtime _LOGIN_OPS)", JSON.stringify(S.LOGIN_OPS) === JSON.stringify(["probe", "sim_test", "start"])
    && /^_LOGIN_OPS = \("probe", "sim_test", "start"\)$/m.test(fs.readFileSync(path.join(RT, "sinopac_local.py"), "utf8")));
  sent.length = 0; await sp.step("probe");
  ok("4 bind／secrets／stop 不走 step", (await sp.step("bind")).code === "BAD_ARGS" && (await sp.step("secrets")).code === "BAD_ARGS" && (await sp.step("stop")).code === "BAD_ARGS" && sent.length === 1);
  reply = { ok: false, error: "Refused: WORKER_RUNNING: the 永豐 worker is logged in" };
  ok("4 機器的錯只回代號", JSON.stringify(await sp.step("probe")) === JSON.stringify({ code: "WORKER_RUNNING" }));
  sent.length = 0; reply = { ok: true, result: { secrets: "ok" } };
  const rep = (needs) => ({ sinopac_local: { secrets: !needs, needs_secrets: needs, worker_running: false } });
  ok("4 needs_secrets false / 舊 runtime 沒那一欄 → 不補交", (await sp.resync(rep(false))) === null && (await sp.resync({ venues: { sinopac: { credentials: true } } })) === null
    && (await sp.resync({ sinopac_local: { secrets: false } })) === null && sent.length === 0);
  const r1 = await sp.resync(rep(true));
  ok("4 daemon 剛起來 → 補交 secrets(沒有 src)", r1 && r1.code === "OK" && sent[0].args.op === "secrets" && !("src" in open(sent[0].args.sealed, SECRET)));
  ok("4 30 秒內不重送", (await sp.resync(rep(true))) === null && sent.length === 1);
  now += 30000;
  ok("4 30 秒後再送", (await sp.resync(rep(true))) !== null && sent.length === 2);
  sp.forget();
  ok("2 forget 刪掉存的那組", !fs.existsSync(path.join(ud, "sinopac.bin")) && sp.info().saved === false);
  const noSeal = S.createSinopac({ userData: path.join(tmp, "ud2"), seal: { available: () => false }, host: () => host, pickFile: async () => pfx });
  await noSeal.pick();
  ok("2 加密儲存不能用 → NO_SEAL,不送不存", (await noSeal.bind({ apiKey: K, secret: SK, personId: ID, caPassword: "" })).code === "NO_SEAL" && !fs.existsSync(path.join(tmp, "ud2", "sinopac.bin")));

  // 5. daemon.js
  const sealed = S.sealFor(SECRET, { a: 1 });
  ok("5 sinopac_local 只有主行程送得出", D.MAIN_ONLY_COMMANDS.has("sinopac_local") && !D.UI_COMMANDS.has("sinopac_local"));
  ok("5 bind／secrets 帶密文才收;其餘只收 {op}", D.argsOk("sinopac_local", { op: "bind", sealed }, true) === true && D.argsOk("sinopac_local", { op: "secrets", sealed }, true) === true
    && ["setup", "stop"].every((op) => D.argsOk("sinopac_local", { op }, true) === true)
    && ["probe", "sim_test", "start"].every((op) => D.argsOk("sinopac_local", { op, expect: sealed }, true) === true && D.argsOk("sinopac_local", { op }, true) === false
      && D.argsOk("sinopac_local", { op, expect: "not base64!" }, true) === false)
    && D.argsOk("sinopac_local", { op: "bind" }, true) === false && D.argsOk("sinopac_local", { op: "probe", x: 1 }, true) === false
    && D.argsOk("sinopac_local", { op: "nope" }, true) === false && D.argsOk("sinopac_local", { op: "bind", sealed: "not base64!" }, true) === false);
  ok("5 解除連接:機器寫的五行都拿得掉", D.argsOk("credentials_remove", { env: D.SINOPAC_ENV.map((k) => k.toLowerCase()) }) === true && D.SINOPAC_ENV.length === 5);
  const svc = fs.readFileSync(path.join(RT, "sinopac_service.py"), "utf8"), be = /def bound_env[\s\S]*?return \{([\s\S]*?)\}\n/.exec(svc);
  const names = be ? [...be[1].matchAll(/"(sinopac_[a-z_]+)"/g)].map((m) => m[1].toUpperCase()).sort() : [];
  ok("5 SINOPAC_ENV = runtime sinopac_service.bound_env 寫的那幾行", JSON.stringify(names) === JSON.stringify(D.SINOPAC_ENV.slice().sort()), names);
  // 6. 雲端
  { const CS = require("../shell/cloud_sinopac");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64"), KID = "0123456789abcdef0123456789abcdef";
    const cs = [], replies = [];
    const C = CS.createSinopacCloud({ send: async (cmd, args) => { cs.push({ cmd, args }); return replies.shift() || { ok: true, result: {} }; },
      pick: async () => "/x/A123456789.pfx", stat: () => ({ size: 5 }), readFile: () => Buffer.from("PFXv1") });
    const openEnv = (e) => { const aes = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
      const ct = Buffer.from(e.ct, "base64"), d = crypto.createDecipheriv("aes-256-gcm", aes, Buffer.from(e.iv, "base64")); d.setAAD(Buffer.from(KID)); d.setAuthTag(ct.subarray(ct.length - 16));
      return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8")); };
    const F = { apiKey: K, secret: SK, personId: "a123456789", caPassword: "" };
    ok("6 沒選檔不送", (await C.upload(F)).code === "NO_PFX" && cs.length === 0);
    ok("6 選檔只回代號(檔名不回)", JSON.stringify(await C.pick()) === JSON.stringify({ code: "OK" }));
    replies.push({ ok: true, result: { key_id: KID, alg: "RSA-OAEP-256+A256GCM", spki } }, { ok: false, kind: "unknown" });
    const u = await C.upload(F), body = openEnv(cs[1].args.envelope);
    ok("6 公鑰 → sinopac_pfx;長步驟回條沒到 = SENT", u.code === "SENT" && cs[0].cmd === "sinopac_pfx_key" && cs[1].cmd === "sinopac_pfx" && cs[1].args.key_id === KID);
    ok("6 封包是整組:pfx、金鑰、身分證轉大寫、一格 = ca_password \"\"", JSON.stringify(body) === JSON.stringify({ pfx: Buffer.from("PFXv1").toString("base64"), api_key: K, secret_key: SK, person_id: ID, ca_password: "" }));
    ok("6 api 轉送的那一包裡沒有明文", !JSON.stringify(cs[1].args).includes(SK) && !JSON.stringify(cs[1].args).includes(ID));
    cs.length = 0;
    replies.push({ ok: true, result: { key_id: KID, alg: "RSA-OAEP-256+A256GCM", spki } }, { ok: false, kind: "rejected", error: "ValueError: KEY_EXPIRED: request a new key" },
      { ok: true, result: { key_id: KID, alg: "RSA-OAEP-256+A256GCM", spki } }, { ok: true, result: { cert: {} } });
    ok("6 KEY_EXPIRED:重要一把、只重試一次", (await C.upload(F)).code === "OK" && cs.map((x) => x.cmd).join() === "sinopac_pfx_key,sinopac_pfx,sinopac_pfx_key,sinopac_pfx");
    cs.length = 0;
    ok("6 步驟對到 sinopac_* 指令,不帶參數", (await C.step("start")).code === "OK" && cs[0].cmd === "sinopac_finish" && JSON.stringify(cs[0].args) === "{}" && (await C.step("bind")).code === "BAD_ARGS");
    C.forget();
    ok("6 forget 之後要重選", (await C.upload(F)).code === "NO_PFX"); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
})();
