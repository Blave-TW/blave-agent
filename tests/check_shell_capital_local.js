// 群益本機開通的憑證那一段 — 主行程這一側(shell/capital_local.js + shell/fetchbuf.js)。不起 Electron、不連網、不碰群益、不跑 PowerShell。
//   1. 下載:Referer 每一跳都帶;跳出 capital.com.tw 或跳到 http 就停;超過上限停
//   2. 精靈:簽章 Valid 且簽署者 CN 正好是程信科技才執行;雜湊不同照跑、日誌只有雜湊／大小／簽署者;簽章不對 / 下載不到 → 不執行、開憑證專區、不留 tmp;
//      檔案沒換就不重驗簽章、換了就重驗;一般權限 detached、不帶參數;精靈還活著 → BUSY、沒有第二個;2 秒內就結束或 spawn 失敗 → START
//   3. 找憑證:篩選跟 runtime _PS_LIST 一字不差、腳本不輸出 cn;開精靈前就在的那張不算新的;新的那張才做一次 key-sign;回給畫面的沒有 thumbprint / cn
//   4. 系統地區:只有 ACP 950 通過;讀不到不擋;選單名只有繁中介面用中文那組
//   5. 匯入 pfx:路徑與匯出密碼只走 stdin(命令列上沒有);匯入器 = 雲端已驗的 certutil 那一行;腳本只輸出 code / exp;回傳沒有路徑
//   6. main.js / preload.js 的接線
// 跑法:node tests/check_shell_capital_local.js
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), EventEmitter = require("events");
const https = require("https");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
const ROOT = path.join(__dirname, ".."), SHELL = path.join(ROOT, "shell");

(async () => {
  // 1. 下載(換掉 https.get,看每一跳帶了什麼)
  const realGet = https.get, hops = [];
  let routes = {};
  https.get = (url, o, cb) => {
    hops.push({ url: String(url), headers: Object.assign({}, o.headers) });
    const req = new EventEmitter(); req.destroy = (e) => { if (e) setImmediate(() => req.emit("error", e)); };
    const r = routes[String(url)] || { status: 404 };
    setImmediate(() => {
      const res = new EventEmitter(); res.statusCode = r.status; res.headers = r.location ? { location: r.location } : {}; res.resume = () => {};
      cb(res);
      if (r.status === 200) { (r.chunks || []).forEach((c) => res.emit("data", Buffer.from(c))); res.emit("end"); }
    });
    return req;
  };
  const { fetchBuffer } = require("../shell/fetchbuf");
  const A = "https://www.capital.com.tw/CapitalGWAPI/srvcms/api/File/669", REF = { Referer: "https://www.capital.com.tw/web/" };
  routes = { [A]: { status: 302, location: "https://dl.capital.com.tw/x.exe" }, "https://dl.capital.com.tw/x.exe": { status: 200, chunks: ["MZ", "abc"] } };
  const got = await fetchBuffer(A, 100, { headers: REF, host: "capital.com.tw" });
  ok("1 跳一次:兩跳都帶 Referer、拿到內容", got.toString() === "MZabc" && hops.length === 2 && hops.every((h) => h.headers.Referer === REF.Referer), hops);
  const fail = async (rt, max) => { routes = rt; hops.length = 0; try { await fetchBuffer(A, max || 100, { headers: REF, host: "capital.com.tw" }); return "resolved"; } catch (e) { return e.message; } };
  ok("1 跳出 capital.com.tw → REDIRECT", (await fail({ [A]: { status: 302, location: "https://evil.example/x.exe" } })) === "REDIRECT");
  ok("1 長得像的網域(capital.com.tw.evil)也擋", (await fail({ [A]: { status: 302, location: "https://capital.com.tw.evil.io/x" } })) === "REDIRECT");
  ok("1 跳到 http → REDIRECT", (await fail({ [A]: { status: 302, location: "http://www.capital.com.tw/x" } })) === "REDIRECT");
  ok("1 403(群益改了 Referer 白名單)→ HTTP_403", (await fail({ [A]: { status: 403 } })) === "HTTP_403");
  ok("1 超過上限 → TOO_LARGE", (await fail({ [A]: { status: 200, chunks: ["12345", "67890"] } }, 6)) === "TOO_LARGE");
  https.get = realGet;

  // 共用的假 PowerShell / spawn
  const L = require("../shell/capital_local");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "capl-")), ud = path.join(tmp, "ud");
  const T1 = "A".repeat(40), T2 = "B".repeat(40), T3 = "C".repeat(40);
  const NOW = Math.floor(Date.now() / 1000), Y = 365 * 86400;
  // 10-20 在 test-4 讀到的那份(subject / issuer 原樣)
const REAL_SIG = { status: "Valid", signer: L.WIZ_SIGNER, subject: "E=guw@changingtec.com, CN=Changing Information Technology Inc., OU=MIS Dept., O=Changing Information Technology Inc., STREET=\"2F, 48 Park Ave.2, Hsinchu Science Park\", L=Hsinchu, S=Taiwan, C=TW, SERIALNUMBER=16325089", issuer: "CN=GlobalSign GCC R45 EV CodeSigning CA 2020, O=GlobalSign nv-sa, C=BE" };
let store = [], sigOut = REAL_SIG, keyOut = "ok", acp = "    ACP    REG_SZ    950", importOut = { code: "OK", exp: NOW + Y };
  const calls = [], logs = [], opened = [], spawned = [];
  const run = async (exe, argv, o) => {
    const script = argv[argv.length - 1];
    calls.push({ exe, argv, o: o || {} });
    if (exe === "reg.exe") return acp === null ? { rc: 1, out: "" } : { rc: 0, out: "HKEY_LOCAL_MACHINE\\...\\CodePage\r\n" + acp + "\r\n" };
    if (script === L.PS_LIST) return { rc: 0, out: JSON.stringify(store) };
    if (script === L.PS_SIG) return { rc: 0, out: JSON.stringify(sigOut) };
    if (script === L.PS_KEYSIGN) return { rc: 0, out: keyOut + "\r\n" };
    if (script === L.PS_IMPORT) return { rc: 0, out: JSON.stringify(importOut) };
    return { rc: 1, out: "" };
  };
  let spawnMode = "stay";
  const spawnFn = (exe, argv, o) => {
    const c = new EventEmitter(); c.unref = () => {}; spawned.push({ exe, argv, o, c });
    if (spawnMode === "error") setImmediate(() => c.emit("error", new Error("EACCES")));
    if (spawnMode === "exit") setTimeout(() => c.emit("exit", 1), 5);
    return c;
  };
  let wizBytes = Buffer.from("MZ-fake-wizard"), fetchErr = null, fetchedWith = null;
  const mk = (o) => L.createCapitalLocal(Object.assign({ userData: ud, platform: "win32", run, spawnFn, launchWaitMs: 30,
    fetchBuffer: async (url, max, opts) => { fetchedWith = { url, max, opts }; if (fetchErr) throw fetchErr; return wizBytes; },
    openExternal: (u) => opened.push(u), log: (m) => logs.push(m), pickFile: async () => null, uiLang: () => "en-US" }, o || {}));
  const cert = (t, o) => Object.assign({ t, cn: "A123456789", subject: "CN=A123456789, OU=The Capital Group", expired: false, key: true, exp: NOW + Y }, o || {});
  const wizPath = path.join(ud, "capital", "RAWinApp.exe");
  const sigCalls = () => calls.filter((c) => c.argv[c.argv.length - 1] === L.PS_SIG).length;

  // 2. 精靈
  let cl = mk();
  const r2 = await cl.openWizard();
  const sp = spawned[spawned.length - 1];
  ok("2 第一次:固定網址、帶 Referer、鎖 capital.com.tw 網域", fetchedWith && fetchedWith.url === L.WIZ_URL && fetchedWith.opts.headers.Referer === "https://www.capital.com.tw/web/" && fetchedWith.opts.host === "capital.com.tw");
  ok("2 簽章對 → 以一般權限 detached 打開 userData\\capital\\RAWinApp.exe,不帶參數", r2.code === "OK" && sp.exe === wizPath && sp.argv.length === 0 && sp.o.detached === true
    && sp.o.cwd === path.join(ud, "capital") && !/runas|verb/i.test(JSON.stringify(sp.o)), r2);
  ok("2 驗簽章的路徑走環境變數(不拼進腳本),檔名不含 setup/install/update", calls.some((c) => c.argv[c.argv.length - 1] === L.PS_SIG && /\.tmp$/.test(c.o.env.CAPL_P)) && !/setup|install|update/i.test(path.basename(wizPath)));
  ok("2 雜湊跟已知值不同(群益改版)照跑,日誌只記雜湊、大小、簽署者", logs.length === 1 && logs[0] === `[capital_local] wizard hash changed sha256=${crypto.createHash("sha256").update(wizBytes).digest("hex")} size=${wizBytes.length} signer=${L.WIZ_SIGNER}`, logs);
  ok("2 驗完才 rename,沒有留下 tmp", fs.existsSync(wizPath) && fs.readdirSync(path.join(ud, "capital")).every((f) => !/\.tmp$/.test(f)));
  const n2 = spawned.length;
  ok("2 精靈還開著再按 → BUSY,沒有第二個", (await cl.openWizard()).code === "BUSY" && spawned.length === n2);
  sp.c.emit("exit", 0);
  const sc0 = sigCalls();
  ok("2 精靈關了可以再開;檔案沒換 → 不重跑簽章", (await cl.openWizard()).code === "OK" && spawned.length === n2 + 1 && sigCalls() === sc0);
  spawned[spawned.length - 1].c.emit("exit", 0);
  fs.writeFileSync(wizPath, Buffer.from("MZ-replaced"));
  await cl.openWizard();
  ok("2 檔案換了(雜湊跟驗過的不同)→ 重驗簽章", sigCalls() === sc0 + 1);
  spawned[spawned.length - 1].c.emit("exit", 0);
  // 簽章不對的三種
  for (const [name, so] of [["不是 Valid", { status: "HashMismatch", signer: L.WIZ_SIGNER }], ["簽署者不是程信", { status: "Valid", signer: "Evil Corp" }],
    ["簽署者只是開頭一樣", { status: "Valid", signer: L.WIZ_SIGNER + " Ltd" }], ["沒有簽章", { status: "NotSigned", signer: "" }],
    ["CN 對、但統編不對(另一家同名公司)", Object.assign({}, REAL_SIG, { subject: REAL_SIG.subject.replace("16325089", "99999999") })],
    ["CN 對、但組織不對", Object.assign({}, REAL_SIG, { subject: REAL_SIG.subject.replace("O=Changing Information Technology Inc.", "O=Evil Inc.") })],
    ["CN 對、但發行的 CA 不是 GlobalSign", Object.assign({}, REAL_SIG, { issuer: "CN=Some CA, O=Other CA Ltd, C=US" })]]) {
    fs.rmSync(path.join(ud, "capital"), { recursive: true, force: true }); sigOut = so; opened.length = 0;
    const c2 = mk(), n = spawned.length, r = await c2.openWizard();
    ok("2 " + name + " → SIG,不執行、開憑證專區、不留檔", r.code === "SIG" && spawned.length === n && opened[0] === L.CERT_ZONE_URL
      && (!fs.existsSync(path.join(ud, "capital")) || fs.readdirSync(path.join(ud, "capital")).length === 0), r);
  }
  sigOut = REAL_SIG;
  // 已下載的那份後來驗不過(被換掉):刪掉、重新下載
  fs.mkdirSync(path.join(ud, "capital"), { recursive: true }); fs.writeFileSync(wizPath, "tampered");
  let flip = 0; const runFlip = async (exe, argv, o) => (argv[argv.length - 1] === L.PS_SIG && flip++ === 0 ? { rc: 0, out: JSON.stringify({ status: "HashMismatch", signer: "" }) } : run(exe, argv, o));
  const c3 = mk({ run: runFlip }); fetchedWith = null;
  ok("2 已下載的那份驗不過 → 刪掉重新下載、驗過才開", (await c3.openWizard()).code === "OK" && fetchedWith !== null && fs.readFileSync(wizPath).equals(wizBytes));
  spawned[spawned.length - 1].c.emit("exit", 0);
  fs.rmSync(path.join(ud, "capital"), { recursive: true, force: true });
  fetchErr = new Error("TIMEOUT"); opened.length = 0;
  ok("2 下載不到 → DOWNLOAD,開憑證專區、不執行", (await mk().openWizard()).code === "DOWNLOAD" && opened[0] === L.CERT_ZONE_URL);
  fetchErr = null;
  spawnMode = "error"; ok("2 spawn error(防毒、AppLocker)→ START", (await mk().openWizard()).code === "START");
  spawnMode = "exit"; const c4 = mk(); ok("2 2 秒內就結束、沒有新憑證 → START,之後不算開著", (await c4.openWizard()).code === "START" && (await c4.scan()).wizOpen === false);
  spawnMode = "stay";
  // 雜湊正好是已知值:不寫日誌(改常數不改程式)
  { const mod = require("module"), file = path.join(SHELL, "capital_local.js");
    const src = fs.readFileSync(file, "utf8").replace(L.WIZ_SHA256, crypto.createHash("sha256").update(wizBytes).digest("hex"));
    const m = new mod(file); m.filename = file; m.paths = mod._nodeModulePaths(SHELL); m._compile(src, m.id);
    fs.rmSync(path.join(ud, "capital"), { recursive: true, force: true }); logs.length = 0;
    const c5 = m.exports.createCapitalLocal({ userData: ud, platform: "win32", run, spawnFn, launchWaitMs: 30, fetchBuffer: async () => wizBytes, log: (x) => logs.push(x), pickFile: async () => null });
    ok("2 雜湊 = 已知值 → 照樣驗簽章、不寫日誌", (await c5.openWizard()).code === "OK" && logs.length === 0 && sigCalls() > 0);
    spawned[spawned.length - 1].c.emit("exit", 0); }
  { sigOut = { status: "HashMismatch", signer: L.WIZ_SIGNER }; fs.rmSync(path.join(ud, "capital"), { recursive: true, force: true });
    const mod = require("module"), file = path.join(SHELL, "capital_local.js");
    const src = fs.readFileSync(file, "utf8").replace(L.WIZ_SHA256, crypto.createHash("sha256").update(wizBytes).digest("hex"));
    const m = new mod(file); m.filename = file; m.paths = mod._nodeModulePaths(SHELL); m._compile(src, m.id);
    const n = spawned.length, c6 = m.exports.createCapitalLocal({ userData: ud, platform: "win32", run, spawnFn, launchWaitMs: 30, fetchBuffer: async () => wizBytes, pickFile: async () => null });
    ok("2 雜湊 = 已知值但簽章不對 → 一樣不執行(閘門是簽章)", (await c6.openWizard()).code === "SIG" && spawned.length === n);
    sigOut = REAL_SIG; }

  // 3. 找憑證
  { const rt = fs.readFileSync(path.join(ROOT, "runtime", "capital_connect.py"), "utf8");
    const pyFilter = /"\$_\.Subject -like '\*OU=The Capital Group\*' -and \$_\.Issuer -like '\*TaiCA\*' \} \| "/.test(rt);
    ok("3 篩選條件跟 runtime _PS_LIST 一字不差(OU + TaiCA)", pyFilter && L.PS_LIST.includes("Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*OU=The Capital Group*' -and $_.Issuer -like '*TaiCA*' } | "));
    ok("3 偵測腳本不輸出 cn / subject", !/\bcn\s*=|SimpleName|\.Subject\s*;|subject\s*=/i.test(L.PS_LIST.replace("$_.Subject -like", "")) && !/SimpleName/.test(L.PS_KEYSIGN)); }
  ok("3 parseList:單筆物件、陣列、壞的 thumbprint 濾掉、cn 不留", JSON.stringify(L.parseList(JSON.stringify(cert(T1)))) === JSON.stringify([{ t: T1, expired: false, key: true, exp: NOW + Y }])
    && L.parseList("[]").length === 0 && L.parseList(JSON.stringify([{ t: "x'; Remove-Item" }, cert(T2)])).length === 1 && L.parseList("").length === 0);
  cl = mk();
  store = [];
  const s0 = await cl.scan();
  ok("3 沒有群益憑證", s0.code === "OK" && s0.usable === 0 && s0.expired === null && s0.fresh === false, s0);
  store = [cert(T1, { expired: true, exp: NOW - 86400 })];
  const s1 = await cl.scan();
  ok("3 只有過期的 → expired 有日期、usable 0", s1.usable === 0 && s1.expired === L.ymd(NOW - 86400), s1);
  store = [cert(T1, { exp: NOW + Y }), cert(T2, { exp: NOW + 2 * Y }), cert(T3, { key: false })];
  const s2 = await cl.scan();
  ok("3 能用的 = 有私鑰、沒過期;到期日取最晚那張", s2.usable === 2 && s2.expiry === L.ymd(NOW + 2 * Y), s2);
  ok("3 回給畫面的沒有 thumbprint、cn、subject", !/AAAA|BBBB|CCCC|A123456789|Capital Group/.test(JSON.stringify(s2)));
  // 快照:開精靈前就在的那張不算新的
  store = [cert(T1, { expired: true, exp: NOW - 86400 })];
  cl = mk(); await cl.openWizard();
  let ks = () => calls.filter((c) => c.argv[c.argv.length - 1] === L.PS_KEYSIGN).length, k0 = ks();
  store = [cert(T1, { expired: true, exp: NOW - 86400 })];
  ok("3 快照裡已有的那張不算新證", (await cl.scan()).fresh === false);
  store = [cert(T1, { expired: false, exp: NOW + Y })];
  ok("3 快照裡那張就算後來看起來能用也不算新證(撤銷後可能還留在庫裡)", (await cl.scan()).fresh === false);
  store = [cert(T1, { expired: true, exp: NOW - 86400 }), cert(T2, { exp: NOW + Y })];
  keyOut = "ok";
  const f1 = await cl.scan();
  ok("3 快照外的新證 → fresh、做一次 key-sign、thumbprint 走環境變數", f1.fresh === true && f1.keyOk === true && ks() === k0 + 1 && f1.expiry === L.ymd(NOW + Y)
    && calls.filter((c) => c.argv[c.argv.length - 1] === L.PS_KEYSIGN).pop().o.env.CAPL_T === T2, f1);
  await cl.scan();
  ok("3 key-sign 每張只做一次(不放在 3 秒輪詢裡)", ks() === k0 + 1);
  ok("3 key-sign 腳本不把 thumbprint 拼進字串", !L.PS_KEYSIGN.includes(T2) && /\$env:CAPL_T/.test(L.PS_KEYSIGN));
  store = [cert(T1, { expired: true, exp: NOW - 86400 }), cert(T3, { exp: NOW + Y })]; keyOut = "fail";
  ok("3 新證私鑰用不了 → keyOk false", (await cl.scan()).keyOk === false);
  store = [cert(T1, { expired: true, exp: NOW - 86400 }), cert("D".repeat(40), { key: false })];
  ok("3 新證連私鑰都沒有 → keyOk false(不跑 key-sign)", (await cl.scan()).keyOk === false);
  keyOut = "ok";
  ok("3 精靈開著 → wizOpen true;關框(forget)不殺精靈", (await cl.scan()).wizOpen === true && cl.forget() === true && (await cl.scan()).wizOpen === true);
  ok("3 關框後快照丟掉:重開只看有沒有能用的", (await cl.scan()).fresh === false);
  { const n = spawned.length; store = [cert(T1, { expired: true, exp: NOW - 86400 })];
    ok("3 重開框、精靈還開著再按 → BUSY、不開第二個", (await cl.openWizard()).code === "BUSY" && spawned.length === n);
    store = [cert(T1, { expired: true, exp: NOW - 86400 }), cert("E".repeat(40), { exp: NOW + Y })]; keyOut = "ok";
    ok("3 …補拍了快照:精靈之後做完的那張算新證", (await cl.scan()).fresh === true); }
  spawned[spawned.length - 1].c.emit("exit", 0);
  ok("3 精靈關了 → wizOpen false", (await cl.scan()).wizOpen === false);
  const bad = L.createCapitalLocal({ userData: ud, platform: "win32", run: async () => ({ rc: 1, out: "boom A123456789" }), spawnFn, log: (m) => logs.push(m), pickFile: async () => null });
  logs.length = 0;
  const sb = await bad.scan();
  ok("3 讀不到憑證庫 → LIST_FAILED,日誌一句、沒有輸出原文", sb.code === "LIST_FAILED" && logs.length === 1 && !/A123456789/.test(logs[0]), [sb, logs]);
  { const n = spawned.length, failing = mk({ run: async () => ({ rc: 1, out: "" }) });
    ok("3 開精靈前列不出憑證庫 → LIST_FAILED、不開精靈(分不出新舊就別讓庫裡那張被當成新證)", (await failing.openWizard()).code === "LIST_FAILED" && spawned.length === n); }
  const mac = L.createCapitalLocal({ userData: ud, platform: "darwin", run, spawnFn, pickFile: async () => null });
  ok("3 不是 Windows → NOT_WINDOWS(全部)", (await mac.scan()).code === "NOT_WINDOWS" && (await mac.openWizard()).code === "NOT_WINDOWS" && (await mac.locale()).code === "NOT_WINDOWS"
    && (await mac.pickPfx()).code === "NOT_WINDOWS" && (await mac.importPfx("x")).code === "NOT_WINDOWS" && mac.openRegion().code === "NOT_WINDOWS");

  // 4. 系統地區
  const loc = async (a, lang) => { acp = a; return mk({ uiLang: () => lang || "en-US" }).locale(); };
  ok("4 ACP 950 → 通過", (await loc("    ACP    REG_SZ    950")).ok === true);
  ok("4 1252 / 936 / 932 / 65001 → 不通過", (await loc("    ACP    REG_SZ    1252")).ok === false && (await loc("    ACP    REG_SZ    936")).ok === false
    && (await loc("    ACP    REG_SZ    932")).ok === false && (await loc("    ACP    REG_SZ    65001")).ok === false);
  logs.length = 0;
  ok("4 讀不到 → null(不擋)、記日誌", (await loc(null)).ok === null && logs.length === 1);
  ok("4 讀登錄用 reg.exe query HKLM ...\\Nls\\CodePage /v ACP", calls.some((c) => c.exe === "reg.exe" && c.argv.join(" ") === "query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage /v ACP"));
  ok("4 選單名:繁中介面用中文那組,其他(含簡中)用英文", L.winNames("zh-TW") === "zh" && L.winNames("zh-Hant-TW") === "zh" && L.winNames("zh-HK") === "zh"
    && L.winNames("zh-CN") === "en" && L.winNames("zh-Hans-CN") === "en" && L.winNames("en-US") === "en" && L.winNames("") === "en" && (await loc("    ACP    REG_SZ    950", "zh-TW")).names === "zh");
  acp = "    ACP    REG_SZ    950";
  const nr = spawned.length; mk().openRegion();
  ok("4 開地區設定 = control.exe intl.cpl(只開視窗)", spawned.length === nr + 1 && spawned[nr].exe === "control.exe" && spawned[nr].argv.join() === "intl.cpl");

  // 5. 匯入 pfx
  const pfxDir = path.join(tmp, "Desktop"); fs.mkdirSync(pfxDir);
  const pfx = path.join(pfxDir, "CAP-A123456789-20261020.pfx"); fs.writeFileSync(pfx, Buffer.alloc(3000, 1));
  const big = path.join(pfxDir, "big.pfx"); fs.writeFileSync(big, Buffer.alloc(require("../shell/cloud_capital").PFX_MAX_BYTES + 1, 1));
  let pickRet = pfx;
  const ci = mk({ pickFile: async () => pickRet });
  ok("5 沒選檔就匯入 → READ_FAILED", (await ci.importPfx("pw")).code === "READ_FAILED");
  pickRet = "relative.pfx"; ok("5 相對路徑不收", (await ci.pickPfx()).code === "PFX_INVALID");
  pickRet = path.join(pfxDir, "x.txt"); ok("5 不是 .pfx/.p12 不收", (await ci.pickPfx()).code === "PFX_INVALID");
  pickRet = big; ok("5 超過上限 → PFX_TOO_LARGE", (await ci.pickPfx()).code === "PFX_TOO_LARGE");
  pickRet = null; ok("5 取消 → CANCELED", (await ci.pickPfx()).code === "CANCELED");
  pickRet = pfx;
  const pk = await ci.pickPfx();
  ok("5 選好:回給畫面的只有代號(沒有檔名、沒有路徑)", JSON.stringify(pk) === JSON.stringify({ code: "OK" }));
  ok("5 匯出密碼格式不對(換行)→ PFX_PASSWORD,沒跑腳本", (await ci.importPfx("a\nb")).code === "PFX_PASSWORD" && !calls.some((c) => c.argv[c.argv.length - 1] === L.PS_IMPORT));
  importOut = { code: "PFX_PASSWORD", exp: 0 };
  ok("5 腳本回密碼錯 → PFX_PASSWORD,選好的檔留著(可以再試)", (await ci.importPfx("wrong-pw")).code === "PFX_PASSWORD");
  const ic = calls.filter((c) => c.argv[c.argv.length - 1] === L.PS_IMPORT).pop();
  const fed = JSON.parse(Buffer.from(ic.o.stdin.trim(), "base64").toString("utf8"));
  ok("5 路徑與密碼只走 stdin(base64 JSON),命令列與環境變數上沒有", fed.p === pfx && fed.pw === "wrong-pw" && !JSON.stringify(ic.argv).includes("wrong-pw") && !JSON.stringify(ic.argv).includes("A123456789")
    && !JSON.stringify(ic.o.env || {}).includes("wrong-pw"));
  for (const c of ["PFX_INVALID", "PFX_NOT_CAPITAL", "PFX_EXPIRED", "PFX_OLDER", "READ_FAILED", "IMPORT_FAILED"]) { importOut = { code: c, exp: 0 }; const r = await ci.importPfx("pw"); ok("5 " + c + " 原樣回", JSON.stringify(r) === JSON.stringify({ code: c })); }
  importOut = { code: "SOMETHING_NEW", exp: 0, cn: "A123456789" };
  ok("5 沒見過的代號 → IMPORT_FAILED(不轉交原文)", JSON.stringify(await ci.importPfx("pw")) === JSON.stringify({ code: "IMPORT_FAILED" }));
  importOut = { code: "NO_KEY", exp: NOW + Y };
  ok("5 匯進去了但私鑰用不了 → NO_KEY + 到期日", JSON.stringify(await ci.importPfx("pw")) === JSON.stringify({ code: "NO_KEY", expiry: L.ymd(NOW + Y) }));
  importOut = { code: "OK", exp: NOW + Y };
  const okr = await ci.importPfx("right-pw");
  ok("5 成功 → 只有代號與到期日;選好的檔丟掉", JSON.stringify(okr) === JSON.stringify({ code: "OK", expiry: L.ymd(NOW + Y) }) && (await ci.importPfx("right-pw")).code === "READ_FAILED");
  ok("5 匯入不經任何命令列(沒有 certutil、匯出密碼不上 argv):.NET X509Store,葉憑證進 My、中繼進 CA、根不裝(= NoRoot)", !/certutil/i.test(L.PS_IMPORT)
    && /X509Store\('My', 'CurrentUser'\)/.test(L.PS_IMPORT) && /X509Store\('CA', 'CurrentUser'\)/.test(L.PS_IMPORT)
    && /if \(\$x\.Thumbprint -eq \$th\) \{ \$my\.Add\(\$x\) \} elseif \(\$x\.Subject -ne \$x\.Issuer\) \{ \$ca\.Add\(\$x\) \}/.test(L.PS_IMPORT)
    && /'PersistKeySet,UserKeySet'/.test(L.PS_IMPORT));
  ok("5 匯入腳本只輸出 code / exp(cn 只拿來跟庫裡的比)", [...L.PS_IMPORT.matchAll(/Done '([A-Z_]+)' (\$exp|0)/g)].length >= 10 && /ConvertTo-Json -Compress -InputObject @\{ code = \$c; exp = \$e \}/.test(L.PS_IMPORT)
    && [...L.PS_IMPORT.matchAll(/ConvertTo-Json/g)].length === 1 && !/Write-(Host|Output)/.test(L.PS_IMPORT));
  ok("5 檔案與密碼從 stdin 讀、匯入前先驗(密碼、群益發的、沒過期、比這台的舊)", /\[Console\]::In\.ReadLine\(\)/.test(L.PS_IMPORT)
    && ["PFX_NOT_CAPITAL", "PFX_EXPIRED", "PFX_OLDER"].every((c) => L.PS_IMPORT.indexOf(c) > 0 && L.PS_IMPORT.indexOf(c) < L.PS_IMPORT.indexOf("X509Store('My'")));
  ok("5 匯入的篩選也是 OU + TaiCA", (L.PS_IMPORT.match(/-like '\*OU=The Capital Group\*' -and \$_?\w*\.?Issuer -like '\*TaiCA\*'/g) || []).length >= 1 && L.PS_IMPORT.includes("$leaf.Subject -like '*OU=The Capital Group*' -and $leaf.Issuer -like '*TaiCA*'"));
  ok("5 所有日誌都沒有密碼、路徑、身分證、thumbprint", !logs.concat().some((m) => /right-pw|wrong-pw|A123456789|Desktop|AAAA|BBBB/.test(m)));

  // 6. 接線
  const main = fs.readFileSync(path.join(SHELL, "main.js"), "utf8"), pre = fs.readFileSync(path.join(SHELL, "preload.js"), "utf8");
  const CH = ["capl-scan", "capl-locale", "capl-wizard", "capl-region", "capl-pick", "capl-import", "capl-forget"];
  ok("6 七條 IPC 都過 handle(fromOurPage)", CH.every((c) => new RegExp(`handle\\("${c}", `).test(main)) && !/ipcMain\.handle\("capl-/.test(main));
  ok("6 preload 只暴露這十二支", ["caplScan", "caplLocale", "caplWizard", "caplRegion", "caplPick", "caplImport", "caplForget", "caplInfo", "caplConnect", "caplStep", "caplOld", "caplUnbind"].every((n) => pre.includes(n + ": ")) && (pre.match(/capl[A-Z]\w+: /g) || []).length === 12);
  ok("6 帳密那幾條也過 handle(fromOurPage)", ["capl-info", "capl-connect", "capl-step", "capl-old", "capl-unbind"].every((c) => new RegExp(`handle\\("${c}", `).test(main)));
  { const flagMain = /^const CAPL_LOCAL_ON = (true|false);$/m.exec(main), flagUi = /^const CAPL_LOCAL_ON = (true|false);$/m.exec(fs.readFileSync(path.join(SHELL, "renderer", "trade.js"), "utf8"));
    const blk = main.slice(main.indexOf("  if (CAPL_LOCAL_ON) {"), main.indexOf("\n  }\n", main.indexOf("  if (CAPL_LOCAL_ON) {")));
    ok("6 主行程的 CAPL_LOCAL_ON = renderer 那一個;capl-* 只在旗標開時註冊(解除綁定例外:旗標關的版本也要解得掉測試包留下的綁定)、補交也只在開時跑", !!flagMain && !!flagUi && flagMain[1] === flagUi[1]
      && CH.concat(["capl-info", "capl-connect", "capl-step", "capl-old"]).every((c) => blk.includes(`handle("${c}", `)) && !blk.includes('handle("capl-unbind"')
      && (main.match(/handle\("capl-unbind", /g) || []).length === 1 && (main.match(/handle\("capl-/g) || []).length === 12
      && /if \(CAPL_LOCAL_ON\) capitalLocal\(\)\.resync\(r\)/.test(main)); }
  ok("6 主行程把顯示語言交給 capital_local(地區設定的選單名)", /uiLang: \(\) => \{ try \{ return \(app\.getPreferredSystemLanguages\(\)/.test(main));

  // 7. 帳密(主行程):safeStorage、封裝、bind 成功才存、改密碼用存著的身分證、補交、刪舊證
  { const SECRET = "c".repeat(64), D = require("../shell/daemon"), P = require("../shell/president_local");
    const fakeSeal = { available: () => true, encrypt: (v) => Buffer.from("SEALED:" + Buffer.from(v).toString("base64")), decrypt: (b) => Buffer.from(String(b).slice(7), "base64").toString() };
    const sent = []; let reply = { ok: true, result: { bind: "ok" } };
    const host = { send: async (cmd, args, o) => { sent.push({ cmd, args, o }); return reply; }, sealCapital: (obj) => L.sealFor(SECRET, obj) };
    const ud7 = path.join(tmp, "ud7"), c7 = mk({ userData: ud7, seal: fakeSeal, host: () => host });
    const openC = (blob, info, aad) => { const raw = Buffer.from(blob, "base64"), key = crypto.createHmac("sha256", SECRET).update(info).digest();
      const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); d.setAAD(Buffer.from(aad)); d.setAuthTag(raw.subarray(raw.length - 16));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8")); };
    ok("7 身分證格式不對 / 密碼有換行 → 不送、不存", (await c7.connect({ id: "A12345", pw: "x" })).code === "BAD_ID" && (await c7.connect({ id: "A123456789", pw: "a\nb" })).code === "BAD_PW"
      && sent.length === 0 && !fs.existsSync(path.join(ud7, "capital.bin")));
    const r7 = await c7.connect({ id: "a123456789", pw: "trade-pw" });
    const b7 = sent[sent.length - 1];
    ok("7 bind:主行程限定(trusted)、封包打得開、身分證轉大寫", r7.code === "OK" && b7.cmd === "capital_local" && b7.args.op === "bind" && b7.o.trusted === true
      && JSON.stringify(openC(b7.args.sealed, "capital-local-seal-v1", "capital-local-v1")) === JSON.stringify({ id: "A123456789", pw: "trade-pw" }));
    let cross = "opened"; try { openC(b7.args.sealed, "president-local-seal-v1", "president-local-v1"); } catch (_) { cross = "refused"; }
    ok("7 群益的密文用統一的金鑰打不開(反過來也一樣)", cross === "refused" && (() => { try { openC(P.sealFor(SECRET, { a: 1 }), "capital-local-seal-v1", "capital-local-v1"); return false; } catch (_) { return true; } })());
    ok("7 指令與存檔裡都沒有明文;畫面拿得到的只有存了沒有", !JSON.stringify(b7.args).includes("A123456789") && !JSON.stringify(b7.args).includes("trade-pw")
      && !fs.readFileSync(path.join(ud7, "capital.bin"), "utf8").includes("trade-pw") && JSON.stringify(c7.info()) === JSON.stringify({ saved: true, windows: true }));
    reply = { ok: false, error: "ValueError: LIB_OUTDATED: update" };
    ok("7 bind 被拒 → 代號原樣、存著的那組不變", (await c7.connect({ id: "B223456789", pw: "other" })).code === "LIB_OUTDATED" && c7._load().id === "A123456789");
    reply = { ok: true, result: {} };
    await c7.connect({ id: null, pw: "new-pw" });
    ok("7 改交易密碼(id null)→ 用存著的身分證", JSON.stringify(openC(sent[sent.length - 1].args.sealed, "capital-local-seal-v1", "capital-local-v1")) === JSON.stringify({ id: "A123456789", pw: "new-pw" }));
    await c7.step("probe", { afterUnlock: true }); await c7.step("start");
    ok("7 step:probe 只多 after_unlock:true;start 只有 op;亂的名字 / bind 不收", JSON.stringify(sent[sent.length - 2].args) === JSON.stringify({ op: "probe", after_unlock: true })
      && JSON.stringify(sent[sent.length - 1].args) === JSON.stringify({ op: "start" }) && (await c7.step("bind")).code === "BAD_ARGS" && (await c7.step("rm")).code === "BAD_ARGS");
    reply = { ok: false, error: "UNKNOWN_RESULT" };
    ok("7 長步驟回條等不到 → SENT", (await c7.step("setup")).code === "SENT");
    reply = { ok: true, result: {} };
    let clock = Date.now() + 60000;
    const c7b = mk({ userData: ud7, seal: fakeSeal, host: () => host, now: () => clock }), n7 = sent.length;
    await c7b.resync({ capital_local: { secrets: true }, venues: { capital: { credentials: true } } });
    await c7b.resync({ capital_local: { secrets: false }, venues: {} });
    ok("7 補交:已經有了 / .env 沒綁群益 → 不送", sent.length === n7);
    await c7b.resync({ capital_local: { secrets: false }, venues: { capital: { credentials: true } } });
    await c7b.resync({ capital_local: { secrets: false }, venues: { capital: { credentials: true } } });
    ok("7 daemon 空手 → 補交 secrets 一次、30 秒內不重送", sent.length === n7 + 1 && sent[n7].args.op === "secrets" && openC(sent[n7].args.sealed, "capital-local-seal-v1", "capital-local-v1").pw === "new-pw");
    ok("7 daemon.js:capital_local 只有主行程送得出、形狀(bind／secrets 帶密文、probe 只多 after_unlock、其他只有 op)",
      D.MAIN_ONLY_COMMANDS.has("capital_local") && !D.UI_COMMANDS.has("capital_local") && D.argsOk("capital_local", { op: "bind", sealed: "QUJD" }, true)
      && !D.argsOk("capital_local", { op: "bind" }, true) && !D.argsOk("capital_local", { op: "bind", sealed: "not base64!" }, true) && D.argsOk("capital_local", { op: "probe", after_unlock: true }, true)
      && !D.argsOk("capital_local", { op: "probe", after_unlock: false }, true) && D.argsOk("capital_local", { op: "start" }, true) && !D.argsOk("capital_local", { op: "start", x: 1 }, true)
      && !D.argsOk("capital_local", { op: "cert" }, true));
    ok("7 解除綁定拿得掉群益那兩行(安全方向);renderer 寫不了群益", D.argsOk("credentials_remove", { env: ["capital_api_key", "capital_password"] }, false)
      && !D.argsOk("credentials", { env: { CAPITAL_API_KEY: "", CAPITAL_PASSWORD: "x" } }, false) && !D.argsOk("credentials", { env: { CAPITAL_API_KEY: "", CAPITAL_PASSWORD: "x" } }, true));
    fs.mkdirSync(path.join(ud7, "capital"), { recursive: true }); fs.writeFileSync(path.join(ud7, "capital", "RAWinApp.exe"), "x");
    ok("7 解除綁定(unbound)刪掉帳密檔與留在 userData 的精靈(spec §2.2)", c7.unbound() && !fs.existsSync(path.join(ud7, "capital.bin")) && c7.info().saved === false
      && !fs.existsSync(path.join(ud7, "capital", "RAWinApp.exe")));
    // 刪舊證
    let oldOut = { n: 2, keep: NOW + Y };
    const runOld = async (exe, argv, o) => { if (argv[argv.length - 1] === L.PS_OLD) { calls.push({ exe, argv, o: o || {} }); return { rc: 0, out: JSON.stringify(o && o.env && o.env.CAPL_DO === "1" ? { n: 0, keep: NOW + Y } : oldOut) }; } return run(exe, argv, o); };
    const c8 = mk({ run: runOld });
    const plan = await c8.oldCerts(false);
    ok("7 刪舊證:先只數(不刪)→ 張數與留下那張的到期日", JSON.stringify(plan) === JSON.stringify({ code: "OK", n: 2, keep: L.ymd(NOW + Y) }) && !(calls[calls.length - 1].o.env && calls[calls.length - 1].o.env.CAPL_DO));
    ok("7 …確認後才帶 CAPL_DO=1 真的刪", (await c8.oldCerts(true)).n === 0 && calls[calls.length - 1].o.env.CAPL_DO === "1");
    ok("7 刪舊證的腳本:身分證只在腳本裡比、輸出只有 n / keep;篩選同 OU + TaiCA;留下的那張要有私鑰、沒過期", /\$cn = \$keep\.GetNameInfo\('SimpleName', \$false\)/.test(L.PS_OLD)
      && /ConvertTo-Json -Compress -InputObject @\{ n = \$rm\.Count; keep = /.test(L.PS_OLD) && (L.PS_OLD.match(/ConvertTo-Json/g) || []).length === 3
      && L.PS_OLD.indexOf("GetRSAPrivateKey($keep)") > 0 && L.PS_OLD.indexOf("GetRSAPrivateKey($keep)") < L.PS_OLD.indexOf("$cn = $keep")
      && L.PS_OLD.includes("$_.Subject -like '*OU=The Capital Group*' -and $_.Issuer -like '*TaiCA*'") && /\$_\.HasPrivateKey -and \$_\.NotAfter -ge \$now/.test(L.PS_OLD)
      && /-eq '1'\) \{ foreach/.test(L.PS_OLD));
    oldOut = { n: "x" };
    ok("7 腳本回的不像樣 → FAILED", (await c8.oldCerts(false)).code === "FAILED");
    ok("7 身分證／密碼規則 = 雲端 cloud_capital.js 那條", (() => { const cs = fs.readFileSync(path.join(SHELL, "cloud_capital.js"), "utf8"); return cs.includes("const ID_RE = " + String(L.ID_RE) + ";") && cs.includes("const PW_RE = " + String(L.PW_RE) + ";"); })()); }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nall passed");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.log("FAIL  " + (e && e.stack || e)); process.exit(1); });
