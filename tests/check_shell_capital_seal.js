// 群益 pfx 封裝的跨語言往返(shell/cloud_capital.js seal ↔ runtime/capital_connect.py open_envelope)+ 主行程那一層的流程。
//   1. runtime 產的一次性公鑰 → 外殼封 → runtime 解:pfx bytes 與匯出密碼原樣回來;同一把再解一次 = KEY_EXPIRED
//   2. 改壞會紅:密文翻一個 byte / 換 AAD(key_id 對不上)/ 換成別把公鑰 → 解不開
//   3. createCapital:公鑰在上傳時才要、KEY_EXPIRED 自動重要一把只重試一次、回條沒到的長步驟 = SENT、
//      舊 runtime 的 unknown command 與 api 的 UNKNOWN_COMMAND = NOT_CAPABLE、送出的 body 裡沒有明文 pfx 與密碼、
//      forget() 把 buffer 歸零、每次送完都叫 after()
// 需要 cryptography(dev Mac 的 /usr/bin/python3 有)。跑法:node tests/check_shell_capital_seal.js
const path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process"), crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const C = require(path.join(ROOT, "shell", "cloud_capital.js"));
let red = 0; const ok = (n, c) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) red++; };

const PY = fs.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
const probe = cp.spawnSync(PY, ["-c", "import cryptography"]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-capseal-"));
const ws = path.join(tmp, "workspace"); fs.mkdirSync(ws);
const HELPER = `
import json, sys, base64
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "runtime"))})
import capital_connect as cc
if sys.argv[1] == "key":
    print(json.dumps(cc.cmd_pfx_key({})))
else:
    a = json.load(sys.stdin)
    try:
        pfx, pw = cc.open_envelope(a["key_id"], a["envelope"])
        print(json.dumps({"ok": True, "pfx": base64.b64encode(pfx).decode(), "pw": pw}))
    except ValueError as e:
        print(json.dumps({"ok": False, "code": str(e).split(":", 1)[0]}))
`;
const py = (mode, input) => {
  const r = cp.spawnSync(PY, ["-c", HELPER, mode], { input: input ? JSON.stringify(input) : "", env: { ...process.env, BLAVE_AGENT_WORKSPACE: ws } });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return JSON.parse(String(r.stdout).trim().split("\n").pop());
};

(async () => {
  if (probe.status !== 0) { console.log("SKIP  " + PY + " 沒有 cryptography,跨語言那段不跑"); }
  else {
    const pfx = crypto.randomBytes(5268), pw = "匯出密碼 p@ss";   // 非 ASCII:JSON / UTF-8 兩邊要一致
    // 1. 往返
    let k = py("key");
    const env = C.seal(k.spki, k.key_id, pfx, pw);
    ok("信封形狀:v1、alg、ek/iv/ct 標準 base64", env.v === 1 && env.alg === C.ALG && ["ek", "iv", "ct"].every((x) => /^[A-Za-z0-9+/]+=*$/.test(env[x])) && Buffer.from(env.iv, "base64").length === 12);
    let r = py("open", { key_id: k.key_id, envelope: env });
    ok("runtime 解得開、pfx 與密碼原樣", r.ok && Buffer.from(r.pfx, "base64").equals(pfx) && r.pw === pw);
    r = py("open", { key_id: k.key_id, envelope: env });
    ok("同一把再解一次 = KEY_EXPIRED(一把只解一次)", !r.ok && r.code === "KEY_EXPIRED");
    // 2. 改壞會紅
    k = py("key");
    const bad = C.seal(k.spki, k.key_id, pfx, pw), ct = Buffer.from(bad.ct, "base64"); ct[10] ^= 1;
    r = py("open", { key_id: k.key_id, envelope: { ...bad, ct: ct.toString("base64") } });
    ok("密文翻一個 byte → ENVELOPE_INVALID", !r.ok && r.code === "ENVELOPE_INVALID");
    k = py("key");
    const wrongAad = C.seal(k.spki, "0".repeat(32), pfx, pw);
    r = py("open", { key_id: k.key_id, envelope: wrongAad });
    ok("AAD 不是這把的 key_id → ENVELOPE_INVALID", !r.ok && r.code === "ENVELOPE_INVALID");
    k = py("key");
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    r = py("open", { key_id: k.key_id, envelope: C.seal(other, k.key_id, pfx, pw) });
    ok("用別把公鑰封 → ENVELOPE_INVALID", !r.ok && r.code === "ENVELOPE_INVALID");
    const k1 = py("key"), k2 = py("key");
    r = py("open", { key_id: k1.key_id, envelope: C.seal(k1.spki, k1.key_id, pfx, pw) });
    ok("新要一把會作廢舊的 → KEY_EXPIRED", !r.ok && r.code === "KEY_EXPIRED" && k2.key_id !== k1.key_id);
  }

  // 3. createCapital(假的 send;公鑰用 Node 產,驗 upload 真的封了、body 沒有明文)
  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = kp.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const PFX = Buffer.from("PFX-BYTES-" + "x".repeat(200)), PW = "export-secret-123";
  const mk = (script) => {
    const calls = []; let afters = 0;
    const cap = C.createCapital({
      send: async (cmd, args, secrets) => { calls.push({ cmd, args: JSON.parse(JSON.stringify(args)), secrets }); return script(cmd, args, calls); },
      pick: async () => "/x/me.pfx", stat: () => ({ size: PFX.length }), readFile: () => Buffer.from(PFX), basename: () => "me.pfx",
      after: () => { afters++; },
    });
    return { cap, calls, afters: () => afters };
  };
  let n = 0;
  const keyAck = () => ({ ok: true, result: { key_id: (++n).toString(16).padStart(32, "0"), alg: C.ALG, spki, expires_at: 0 } });
  // 正常:pfx_key → capital_pfx(回條沒到 = SENT)
  let t = mk((cmd) => (cmd === "capital_pfx_key" ? keyAck() : { ok: false, error: "UNKNOWN_RESULT", kind: "unknown" }));
  ok("沒選檔就上傳 = NO_FILE、什麼都沒送", (await t.cap.upload(PW)).code === "NO_FILE" && t.calls.length === 0);
  const picked = await t.cap.pickPfx();
  ok("選檔只回檔名與大小、還沒要公鑰", picked.code === "OK" && picked.name === "me.pfx" && picked.size === PFX.length && !("buf" in picked) && t.calls.length === 0);
  let u = await t.cap.upload(PW);
  ok("上傳:先要公鑰再送 capital_pfx;長步驟回條沒到 = SENT", u.code === "SENT" && t.calls.map((c) => c.cmd).join() === "capital_pfx_key,capital_pfx");
  const sent = JSON.stringify(t.calls[1]);
  ok("送出去的 body 沒有明文 pfx、沒有匯出密碼、沒有 secrets", sent.indexOf(PW) < 0 && sent.indexOf(PFX.toString("base64").slice(0, 40)) < 0 && sent.indexOf("PFX-BYTES") < 0 && t.calls[1].secrets === null);
  const e = t.calls[1].args.envelope, dk = crypto.privateDecrypt({ key: kp.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
  const ctb = Buffer.from(e.ct, "base64"), d = crypto.createDecipheriv("aes-256-gcm", dk, Buffer.from(e.iv, "base64"));
  d.setAAD(Buffer.from(t.calls[1].args.key_id)); d.setAuthTag(ctb.subarray(ctb.length - 16));
  const body = JSON.parse(Buffer.concat([d.update(ctb.subarray(0, ctb.length - 16)), d.final()]).toString());
  ok("封的是那一把公鑰、AAD = 那一把 key_id", Buffer.from(body.pfx, "base64").equals(PFX) && body.password === PW);
  ok("每次送完都叫 after()(要一份新狀態)", t.afters() === 2);
  // KEY_EXPIRED:自動重要一把、只重試一次
  t = mk((cmd) => (cmd === "capital_pfx_key" ? keyAck() : { ok: false, kind: "rejected", error: "ValueError: KEY_EXPIRED: request a new key and upload again" }));
  await t.cap.pickPfx(); u = await t.cap.upload(PW);
  ok("KEY_EXPIRED → 重要一把重送一次,再錯就停", u.code === "KEY_EXPIRED" && t.calls.map((c) => c.cmd).join() === "capital_pfx_key,capital_pfx,capital_pfx_key,capital_pfx");
  // 同步指令回條沒到 → KEY_TIMEOUT;CRYPTO_MISSING 照代號
  t = mk(() => ({ ok: false, error: "UNKNOWN_RESULT", kind: "unknown" })); await t.cap.pickPfx();
  ok("公鑰那一步 20 秒沒回 = KEY_TIMEOUT(不送 capital_pfx)", (await t.cap.upload(PW)).code === "KEY_TIMEOUT" && t.calls.length === 1);
  t = mk(() => ({ ok: false, kind: "rejected", error: "ValueError: CRYPTO_MISSING: run capital_setup first" })); await t.cap.pickPfx();
  ok("主機拒收的代號原樣(CRYPTO_MISSING)", (await t.cap.upload(PW)).code === "CRYPTO_MISSING");
  // forget 把 buffer 歸零
  const bufs = []; t = C.createCapital({ send: async () => ({}), pick: async () => "/p", stat: () => ({ size: 4 }), readFile: () => { const b = Buffer.from("abcd"); bufs.push(b); return b; }, basename: () => "p" });
  await t.pickPfx(); t.forget();
  ok("forget():buffer 歸零、之後上傳 = NO_FILE", bufs[0].equals(Buffer.alloc(4)) && !t.hasFile() && (await t.upload(PW)).code === "NO_FILE");
  // 太大 / 讀到的長度不對
  t = C.createCapital({ send: async () => ({}), pick: async () => "/p", stat: () => ({ size: C.PFX_MAX_BYTES + 1 }), readFile: () => Buffer.alloc(1), basename: () => "p" });
  ok("超過 16KB 在選檔時就擋", (await t.pickPfx()).code === "PFX_TOO_LARGE" && !t.hasFile());

  // interpret:過渡期與各桶
  ok("舊 runtime 的 unknown command = NOT_CAPABLE", C.interpret({ ok: false, kind: "rejected", error: "ValueError: unknown command 'capital_setup'" }).code === "NOT_CAPABLE");
  ok("api 還沒放行的 400 UNKNOWN_COMMAND = NOT_CAPABLE", C.interpret({ ok: false, kind: "undelivered", error: "UNKNOWN_COMMAND" }).code === "NOT_CAPABLE");
  ok("不帶說明的代號(ValueError: BUSY)也認得", C.interpret({ ok: false, kind: "rejected", error: "ValueError: BUSY" }).code === "BUSY");
  ok("PW_RECHECK_NEEDED 帶說明", C.interpret({ ok: false, kind: "rejected", error: "ValueError: PW_RECHECK_NEEDED: 群益 refused" }).code === "PW_RECHECK_NEEDED");
  ok("認不出的拒收 = REJECTED(原文不往上交)", (() => { const x = C.interpret({ ok: false, kind: "rejected", error: "Traceback secret=abc" }); return x.code === "REJECTED" && Object.keys(x).length === 1; })());
  ok("主機沒在跑 = UNDELIVERED 帶 machineState", (() => { const x = C.interpret({ ok: false, kind: "undelivered", error: "MACHINE_NOT_RUNNING", machineState: "stopped" }); return x.code === "UNDELIVERED" && x.machineState === "stopped"; })());
  // 帳密
  t = mk(() => ({ ok: true, result: "credentials=2" }));
  ok("帳密空的不送", (await t.cap.saveCreds({ id: "", pw: "x" })).code === "INCOMPLETE" && t.calls.length === 0);
  ok("帳密有換行不送", (await t.cap.saveCreds({ id: "A123456789", pw: "a\nb" })).code === "BAD_FORMAT" && t.calls.length === 0);
  const sc = await t.cap.saveCreds({ id: " a123456789 ", pw: "pw 1" });
  ok("帳密:venue capital、secrets 兩個小寫名、ID 去空白轉大寫、密碼原樣", sc.code === "OK" && t.calls[0].cmd === "credentials" && t.calls[0].args.venue === "capital"
    && t.calls[0].secrets && t.calls[0].secrets.capital_api_key === "A123456789" && t.calls[0].secrets.capital_password === "" /* 送完就清掉 */);
  ok("身分證字號格式(與 web 同):國民身分證、新式 / 舊式居留證號過;亂碼、長度不對不過",
    ["A123456789", "a223456789", "A823456789", "A923456789", "AB12345678", "FD12345678"].every((id) => !C.credSecrets({ id, pw: "x" }).error)
    && ["A323456789", "AE12345678", "12345678", "A12345678", "A1234567890", "ABCDEFGHIJ"].every((id) => C.credSecrets({ id, pw: "x" }).error === "BAD_FORMAT"));
  ok("交易密碼不 trim(前後空白也是密碼,與 web 同)", C.credSecrets({ id: "A123456789", pw: " pw " }).secrets.capital_password === " pw ");
  t = mk(() => ({ ok: false, error: "UNKNOWN_RESULT", kind: "unknown" }));
  ok("帳密回條沒到 = UNKNOWN_RESULT(不當成功)", (await t.cap.saveCreds({ id: "A123456789", pw: "x" })).code === "UNKNOWN_RESULT");
  t = mk(() => ({ ok: false, error: "UNKNOWN_RESULT", kind: "unknown" }));
  ok("步驟白名單:setup / probe / unlock / finish;unlock 帶 after_unlock:true", (await t.cap.step("unlock")).code === "SENT" && t.calls[0].cmd === "capital_probe" && t.calls[0].args.after_unlock === true
    && (await t.cap.step("capital_pfx_key")).code === "BAD_ARGS" && t.calls.length === 1);
  ok("解綁送固定兩個名字", (await t.cap.unbind()) && t.calls[1].cmd === "credentials_remove" && JSON.stringify(t.calls[1].args) === JSON.stringify({ env: ["capital_api_key", "capital_password"] }));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `${red} FAIL` : "ALL PASS");
  process.exit(red ? 1 : 0);
})();
