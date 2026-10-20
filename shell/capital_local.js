/* 群益本機開通(電腦版 Windows)的「憑證」那一段 — 主行程這一側。畫面在 renderer/capital_local.js。
   spec output/specs/desktop-capital-new-cert-2026-10-20.md(先找憑證 → 申請新憑證或匯入 pfx → 帳密)。
   - 憑證庫:讀啟動者的 Cert:\CurrentUser\My,篩選照 runtime/capital_connect._PS_LIST 一字不差,但不輸出 cn(身分證)。
     thumbprint 只留在這個行程做新舊比對;回給畫面的只有張數、到期日、有沒有新的一張、私鑰能不能用。
   - 憑證精靈(RAWinApp.exe):固定官方網址 + Referer 下載到 userData;執行閘門是 Authenticode Valid 且簽署者是程信科技,
     雜湊只記錄(Wei 10-20:群益改版不必等我們發版)。以一般權限 detached 打開,**只負責打開**——身分證、密碼、簡訊碼都在群益自己的視窗。
   - 匯入 pfx:檔案路徑與匯出密碼只在這個行程,經 stdin 交給 PowerShell;驗證與匯入都在那支腳本裡(cn 不出腳本),
     匯入用 .NET X509Store(葉憑證進 CurrentUser\My、中繼進 CA、根不裝 = certutil 的 NoRoot),匯出密碼不上任何命令列。
     待 test-4 驗:SKCOM 認不認這樣匯入的私鑰(雲端已驗的是 certutil;不認就回到 certutil、並擋含 " 的密碼)。
   不依賴 electron(tests/check_shell_capital_local.js 直接 require)。 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { fetchBuffer: defaultFetch } = require("./fetchbuf");

// research/capital-experiments-round0:下載點不帶 Referer 回 403;1.0.23.208 的雜湊(只用來決定要不要寫日誌)
const WIZ_URL = "https://www.capital.com.tw/CapitalGWAPI/srvcms/api/File/669";
const WIZ_HEADERS = { Referer: "https://www.capital.com.tw/web/" };
const WIZ_HOST = "capital.com.tw";
const WIZ_SHA256 = "730566719ea53f3bcc91838cfa6c28f827e77aecef6fc09262350160de1bb7e1";
const WIZ_MAX_BYTES = 16 * 1024 * 1024;
const WIZ_SIGNER = "Changing Information Technology Inc.";   // 簽章憑證 CN(10-20 在 test-4 讀過);憑證本身已過期,靠時間戳仍 Valid
const CERT_ZONE_URL = "https://www.capital.com.tw/web/#/certificate/ap";
const PFX_MAX_BYTES = require("./cloud_capital").PFX_MAX_BYTES;
const PFX_PW_RE = /^[^\r\n\0]{1,128}$/;
const THUMB_RE = /^[0-9A-F]{40}$/;
const LAUNCH_WAIT_MS = 2000;   // 這麼快就結束、又沒有新憑證 = 被擋下(防毒、AppLocker、智慧型應用程式控制)

const PS_HEAD = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; ";
const PS_LIST = PS_HEAD +
  "$now = Get-Date; " +
  "$r = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { " +
  "$_.Subject -like '*OU=The Capital Group*' -and $_.Issuer -like '*TaiCA*' } | " +
  "ForEach-Object { [pscustomobject]@{ t = $_.Thumbprint; " +
  "expired = ($_.NotAfter -lt $now); key = $_.HasPrivateKey; " +
  "exp = ([DateTimeOffset]$_.NotAfter).ToUnixTimeSeconds() } }); " +
  "ConvertTo-Json -InputObject $r -Compress";
// m0_certcheck.ps1 Test-Key:真的用一次私鑰(DPAPI 解不開就在這裡失敗)。thumbprint 走環境變數、先驗過形狀
const PS_KEYSIGN = PS_HEAD + "try { $c = Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $env:CAPL_T) -ErrorAction Stop; " +
  "$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c); " +
  "if (-not $rsa) { 'nokey'; exit 0 }; $d = [byte[]](1..32); " +
  "try { [void]$rsa.SignData($d, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) } " +
  "catch { [void]$rsa.SignData($d, [System.Security.Cryptography.HashAlgorithmName]::SHA1, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) }; 'ok' } catch { 'fail' }";
const PS_SIG = PS_HEAD + "$s = Get-AuthenticodeSignature -LiteralPath $env:CAPL_P; $n = ''; $sub = ''; $iss = ''; " +
  "if ($s.SignerCertificate) { $n = $s.SignerCertificate.GetNameInfo('SimpleName', $false); $sub = $s.SignerCertificate.Subject; $iss = $s.SignerCertificate.Issuer }; " +
  "ConvertTo-Json -Compress -InputObject @{ status = [string]$s.Status; signer = [string]$n; subject = [string]$sub; issuer = [string]$iss }";
// 簽署者不只看 CN:EV 憑證的組織、公司統編(SERIALNUMBER,換發也不變)與發行的 CA(10-20 在 test-4 讀過;不釘 thumbprint——憑證到期會換)
const WIZ_SUBJECT_RES = [/(^|, )CN=Changing Information Technology Inc\.(,|$)/, /(^|, )O=Changing Information Technology Inc\.(,|$)/, /(^|, )SERIALNUMBER=16325089(,|$)/];
const WIZ_ISSUER_RE = /(^|, )O=GlobalSign nv-sa(,|$)/;
/* 匯入:stdin 一行 base64(UTF-8 JSON {p, pw})。輸出只有 {code, exp}。順序同 runtime vehicle_import:先驗檔(密碼、群益發的、沒過期)、
   這台已經有同一個 ID 更晚到期的 → PFX_OLDER(plan_before_import 的 refuse);同一張已經在而且有私鑰 → 不重匯;
   同一張但沒私鑰的那份先刪(它的壞鍵連結會跟著重匯留下來,602)。匯入後確認那張在、有私鑰、私鑰用得了 */
const PS_IMPORT = PS_HEAD + "$ErrorActionPreference = 'Stop'; " +
  "function Done($c, $e) { ConvertTo-Json -Compress -InputObject @{ code = $c; exp = $e }; exit 0 }; " +
  "try { $a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine().Trim())) | ConvertFrom-Json } catch { Done 'READ_FAILED' 0 }; " +
  "try { $bytes = [IO.File]::ReadAllBytes($a.p) } catch { Done 'READ_FAILED' 0 }; " +
  "$col = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection; " +
  "try { $col.Import($bytes, $a.pw, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet) } " +
  "catch { if ($_.Exception.HResult -eq -2147024810 -or $_.Exception.InnerException.HResult -eq -2147024810) { Done 'PFX_PASSWORD' 0 }; Done 'PFX_INVALID' 0 }; " +
  "$leaf = @($col | Where-Object { $_.HasPrivateKey })[0]; " +
  "if (-not $leaf) { Done 'PFX_INVALID' 0 }; " +
  "$th = $leaf.Thumbprint; $cn = $leaf.GetNameInfo('SimpleName', $false); $na = $leaf.NotAfter; $exp = ([DateTimeOffset]$na).ToUnixTimeSeconds(); " +
  "$cap = ($leaf.Subject -like '*OU=The Capital Group*' -and $leaf.Issuer -like '*TaiCA*'); " +
  "foreach ($x in $col) { $x.Reset() }; " +
  "if (-not $cap) { Done 'PFX_NOT_CAPITAL' 0 }; " +
  "if ($na -lt (Get-Date)) { Done 'PFX_EXPIRED' 0 }; " +
  "$store = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*OU=The Capital Group*' -and $_.Issuer -like '*TaiCA*' }); " +
  "if (@($store | Where-Object { $_.Thumbprint -ne $th -and $_.HasPrivateKey -and $_.NotAfter -ge (Get-Date) -and $_.GetNameInfo('SimpleName', $false) -eq $cn -and $_.NotAfter -gt $na }).Count) { Done 'PFX_OLDER' 0 }; " +
  "$same = @($store | Where-Object { $_.Thumbprint -eq $th }); " +
  "if (-not ($same.Count -and $same[0].HasPrivateKey)) { " +
  "foreach ($x in $same) { Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $x.Thumbprint) }; " +
  "$imp = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection; " +
  "$imp.Import($bytes, $a.pw, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]'PersistKeySet,UserKeySet'); " +
  "$my = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser'); $my.Open('ReadWrite'); " +
  "$ca = New-Object System.Security.Cryptography.X509Certificates.X509Store('CA', 'CurrentUser'); $ca.Open('ReadWrite'); " +
  "foreach ($x in $imp) { if ($x.Thumbprint -eq $th) { $my.Add($x) } elseif ($x.Subject -ne $x.Issuer) { $ca.Add($x) } }; " +
  "$my.Close(); $ca.Close() }; " +
  "$a = $null; " +
  "$got = Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $th) -ErrorAction SilentlyContinue; " +
  "if (-not $got -or -not $got.HasPrivateKey) { Done 'IMPORT_FAILED' 0 }; " +
  "try { $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($got); $d = [byte[]](1..32); " +
  "try { [void]$rsa.SignData($d, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) } " +
  "catch { [void]$rsa.SignData($d, [System.Security.Cryptography.HashAlgorithmName]::SHA1, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) } } catch { Done 'NO_KEY' $exp }; " +
  "Done 'OK' $exp";
/* 刪舊證(設計 l-old-confirm;照 runtime/capital_connect.plan_removals):留下有私鑰、沒過期、到期最晚的那張;刪過期的,
   以及同一個身分證、到期不晚於它的(展延／重發會撤銷舊證,SKCOM 挑到它就 604)。別的身分證的有效證不動。身分證只在這支腳本裡比,
   輸出只有張數與留下那張的到期。$env:CAPL_DO=1 才真的刪(確認框按了之後),刪之前照同一套重算一次 */
const PS_OLD = PS_HEAD + "$now = Get-Date; " +
  "$all = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*OU=The Capital Group*' -and $_.Issuer -like '*TaiCA*' }); " +
  "$keep = @($all | Where-Object { $_.HasPrivateKey -and $_.NotAfter -ge $now } | Sort-Object NotAfter -Descending)[0]; " +
  "if (-not $keep) { ConvertTo-Json -Compress -InputObject @{ n = 0; keep = 0 }; exit 0 }; " +
  // 留下的那張要真的用得了私鑰(F10 那種證不能當成留下的、把同一個身分證的舊證刪掉)
  "try { $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($keep); $d = [byte[]](1..32); " +
  "try { [void]$rsa.SignData($d, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) } " +
  "catch { [void]$rsa.SignData($d, [System.Security.Cryptography.HashAlgorithmName]::SHA1, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) } } " +
  "catch { ConvertTo-Json -Compress -InputObject @{ n = 0; keep = 0 }; exit 0 }; " +
  "$cn = $keep.GetNameInfo('SimpleName', $false); " +
  "$rm = @($all | Where-Object { $_.Thumbprint -ne $keep.Thumbprint -and ($_.NotAfter -lt $now -or ($_.GetNameInfo('SimpleName', $false) -eq $cn -and $_.NotAfter -le $keep.NotAfter)) }); " +
  "if ($env:CAPL_DO -eq '1') { foreach ($x in $rm) { Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $x.Thumbprint) -ErrorAction SilentlyContinue }; " +
  "$rm = @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $rm.Thumbprint -contains $_.Thumbprint }) }; " +
  "ConvertTo-Json -Compress -InputObject @{ n = $rm.Count; keep = ([DateTimeOffset]$keep.NotAfter).ToUnixTimeSeconds() }";
// 帳密的封裝:同 president_local.sealFor 的形狀,另一組 info／AAD(= runtime/capital_local._SEAL_INFO / _SEAL_AAD)
const SEAL_INFO = "capital-local-seal-v1", SEAL_AAD = "capital-local-v1";
function sealFor(secret, obj) {
  const key = crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(SEAL_INFO).digest();
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(SEAL_AAD, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
}
// = shell/cloud_capital.js ID_RE / PW_RE(網頁同一條);密碼不 trim
const ID_RE = /^[A-Z][1289A-D]\d{8}$/, PW_RE = /^[^\r\n]{1,64}$/;
const OPS = ["setup", "probe", "start", "stop"];   // 畫面按得到的;bind / secrets 只走 connect / resync
const RESEND_EVERY_MS = 30000;
const PFX_CODES = ["OK", "PFX_PASSWORD", "PFX_INVALID", "PFX_NOT_CAPITAL", "PFX_EXPIRED", "PFX_OLDER", "READ_FAILED", "IMPORT_FAILED", "NO_KEY"];

// unix 秒 → 本機日期 YYYY/MM/DD(同 renderer capDate)
function ymd(sec) {
  const d = new Date(Number(sec) * 1000);
  if (!isFinite(sec) || isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}
// PS_LIST 的輸出 → [{t, expired, key, exp}];ConvertTo-Json 單筆時不是陣列
function parseList(out) {
  const got = JSON.parse(String(out || "").trim() || "[]");
  const arr = Array.isArray(got) ? got : got && typeof got === "object" ? [got] : [];
  return arr.filter((c) => c && typeof c.t === "string" && THUMB_RE.test(c.t.toUpperCase()))
    .map((c) => ({ t: c.t.toUpperCase(), expired: c.expired === true, key: c.key === true, exp: Number(c.exp) || 0 }));
}
// reg query 的輸出 → ACP 字串(讀不到 null)
function parseAcp(out) { const m = /\bACP\s+REG_SZ\s+(\d+)/.exec(String(out || "")); return m ? m[1] : null; }
// Windows 顯示語言 → 地區設定那幾個選單名用哪一組(只有繁中介面用中文那組)
function winNames(lang) { return /^zh-(hant|tw|hk|mo)\b/i.test(String(lang || "")) ? "zh" : "en"; }

// 系統程式一律走 System32 絕對路徑(同 winsandbox.js):不帶路徑時 Windows 先找程式所在目錄與目前目錄,
// 同名的 powershell.exe(它從 stdin 拿 pfx 路徑與匯出密碼)／reg.exe／control.exe 會被換掉。SystemRoot 不像 `X:\<一層>` 就用 C:\Windows
const ROOT_RE = /^[A-Za-z]:\\[^\\/:*?"<>|\r\n]+$/;
function sys32(systemRoot, ...parts) {
  const root = typeof systemRoot === "string" && ROOT_RE.test(systemRoot) ? systemRoot : "C:\\Windows";
  return path.win32.join(root, "System32", ...parts);
}

function defaultRun(spawnFn) {
  return (exe, argv, o) => new Promise((resolve) => {
    let out = "", done = false;
    const fin = (rc) => { if (done) return; done = true; clearTimeout(tm); resolve({ rc, out }); };
    let c;
    try { c = spawnFn(exe, argv, { windowsHide: true, env: Object.assign({}, process.env, (o && o.env) || {}) }); } catch (_) { resolve({ rc: -1, out: "" }); return; }
    const tm = setTimeout(() => { try { c.kill(); } catch (_) { } fin(-1); }, (o && o.timeoutMs) || 60000);
    c.stdout.on("data", (d) => { if (out.length < 65536) out += d.toString("utf8"); });
    c.stderr.on("data", () => { });
    c.on("error", () => fin(-1));
    c.on("close", (rc) => fin(rc));
    if (o && typeof o.stdin === "string") c.stdin.end(o.stdin); else c.stdin.end();
  });
}

function createCapitalLocal({ userData, platform = process.platform, pickFile, fetchBuffer = defaultFetch, seal, host = () => null,
  spawnFn = require("child_process").spawn, run, openExternal = () => {}, uiLang = () => "", log = () => {}, launchWaitMs = LAUNCH_WAIT_MS, now = () => Date.now(),
  systemRoot = process.env.SystemRoot }) {
  const exec = run || defaultRun(spawnFn);
  const PS_EXE = sys32(systemRoot, "WindowsPowerShell", "v1.0", "powershell.exe");
  const ps = (script, o) => exec(PS_EXE, ["-NoProfile", "-NonInteractive", "-Command", script], o);
  const wizDir = path.join(userData, "capital"), wizPath = path.join(wizDir, "RAWinApp.exe");
  let child = null, opening = false, snapshot = null, sigOk = null, picked = null;
  const keyOf = {};   // thumbprint → key-sign 結果(每張只測一次)
  const win = () => platform === "win32";
  const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

  async function listCerts() {
    const r = await ps(PS_LIST);
    if (r.rc !== 0) throw new Error("LIST_FAILED");
    return parseList(r.out);
  }
  async function keySign(t) {
    if (!THUMB_RE.test(t)) return false;
    if (keyOf[t] !== undefined) return keyOf[t];
    const r = await ps(PS_KEYSIGN, { env: { CAPL_T: t } });
    keyOf[t] = r.rc === 0 && String(r.out).trim() === "ok";
    return keyOf[t];
  }

  /* 開框與等精靈時叫:usable = 有私鑰、沒過期的張數;expired = 沒有能用的、但有過期的那張的到期日(展延那一頁);
     fresh = 開精靈前那份快照裡沒有的一張(沒過期),keyOk = 那張的私鑰用不用得了 */
  async function scan() {
    if (!win()) return { code: "NOT_WINDOWS" };
    let certs;
    try { certs = await listCerts(); } catch (_) { log("[capital_local] cert store listing failed"); return { code: "LIST_FAILED", wizOpen: !!child }; }
    const usable = certs.filter((c) => c.key && !c.expired).sort((a, b) => b.exp - a.exp);
    const expired = certs.filter((c) => c.expired).sort((a, b) => b.exp - a.exp);
    const out = { code: "OK", usable: usable.length, expiry: usable.length ? ymd(usable[0].exp) : null,
      expired: !usable.length && expired.length ? ymd(expired[0].exp) : null, fresh: false, keyOk: null, wizOpen: !!child };
    if (snapshot) {
      const fresh = certs.filter((c) => !c.expired && snapshot.indexOf(c.t) < 0).sort((a, b) => b.exp - a.exp)[0];
      if (fresh) { out.fresh = true; out.expiry = ymd(fresh.exp); out.keyOk = fresh.key ? await keySign(fresh.t) : false; }
    }
    return out;
  }

  async function verifySig(p) {
    const r = await ps(PS_SIG, { env: { CAPL_P: p } });
    let j = null; try { j = JSON.parse(String(r.out).trim()); } catch (_) { }
    const signer = j && typeof j.signer === "string" ? j.signer.slice(0, 200) : "";
    const sub = j && typeof j.subject === "string" ? j.subject : "", iss = j && typeof j.issuer === "string" ? j.issuer : "";
    return { ok: r.rc === 0 && !!j && j.status === "Valid" && signer === WIZ_SIGNER && WIZ_SUBJECT_RES.every((re) => re.test(sub)) && WIZ_ISSUER_RE.test(iss), signer };
  }
  // 下載(或用已下載、驗過的那份)→ 驗簽章 → 回可執行的路徑;回 code 字串 = 失敗(畫面講哪一種)
  async function readyWizard() {
    let buf = null;
    try { buf = fs.readFileSync(wizPath); } catch (_) { /* 還沒下載 */ }
    if (buf) {
      const h = sha256(buf);
      if (sigOk === h) return wizPath;
      const v = await verifySig(wizPath);
      if (v.ok) { sigOk = h; if (h !== WIZ_SHA256) log(`[capital_local] wizard hash changed sha256=${h} size=${buf.length} signer=${v.signer}`); return wizPath; }
      try { fs.unlinkSync(wizPath); } catch (_) { }
    }
    try { buf = await fetchBuffer(WIZ_URL, WIZ_MAX_BYTES, { headers: WIZ_HEADERS, host: WIZ_HOST }); } catch (_) { openExternal(CERT_ZONE_URL); return "DOWNLOAD"; }
    const h = sha256(buf), tmp = wizPath + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    try { fs.mkdirSync(wizDir, { recursive: true }); fs.writeFileSync(tmp, buf); } catch (_) { try { fs.unlinkSync(tmp); } catch (_e) { } return "START"; }
    const v = await verifySig(tmp);
    if (!v.ok) { try { fs.unlinkSync(tmp); } catch (_) { } openExternal(CERT_ZONE_URL); return "SIG"; }
    try { fs.renameSync(tmp, wizPath); } catch (_) { try { fs.unlinkSync(tmp); } catch (_e) { } return "START"; }
    sigOk = h;
    if (h !== WIZ_SHA256) log(`[capital_local] wizard hash changed sha256=${h} size=${buf.length} signer=${v.signer}`);
    return wizPath;
  }
  async function openWizard() {
    if (!win()) return { code: "NOT_WINDOWS" };
    if (child || opening) {
      // 關框又重開(F12)時快照已丟:精靈還在跑、新證還沒落庫(落庫了開框那次就到帳密了),這時補拍才認得出它做完的那張
      // 補拍失敗就不拍(維持 null):分不出新舊時照 F13 只看有沒有能用的,不把庫裡原本那張當新證
      if (!snapshot && child) { try { snapshot = (await listCerts()).map((c) => c.t); } catch (_) { } }
      return { code: "BUSY" };
    }
    opening = true;
    try {
      // 列不出憑證庫就不開精靈:之後分不出哪張是新的,庫裡原本那張會被當成剛申請好的
      if (!snapshot) { try { snapshot = (await listCerts()).map((c) => c.t); } catch (_) { return { code: "LIST_FAILED" }; } }
      const exe = await readyWizard();
      if (exe !== wizPath) return { code: exe };
      let c;
      try { c = spawnFn(exe, [], { cwd: wizDir, detached: true, stdio: "ignore", windowsHide: false }); } catch (_) { return { code: "START" }; }
      const early = await new Promise((resolve) => {
        const tm = setTimeout(() => resolve(null), launchWaitMs);
        c.on("error", () => { clearTimeout(tm); resolve("error"); });
        c.on("exit", () => { clearTimeout(tm); resolve("exit"); });
      });
      if (early === "error") return { code: "START" };
      if (early === "exit") { const s = await scan(); return { code: s.fresh ? "OK" : "START" }; }
      child = c;
      c.on("exit", () => { if (child === c) child = null; });
      if (typeof c.unref === "function") c.unref();
      return { code: "OK" };
    } finally { opening = false; }
  }
  // 系統地區:只有 ACP 950 算通過;讀不到 = 不擋(事實句講不出口),記日誌
  async function locale() {
    if (!win()) return { code: "NOT_WINDOWS" };
    const r = await exec(sys32(systemRoot, "reg.exe"), ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], { timeoutMs: 10000 });
    const acp = r.rc === 0 ? parseAcp(r.out) : null;
    if (!acp) log("[capital_local] system code page unreadable");
    return { code: "OK", ok: acp ? acp === "950" : null, names: winNames(uiLang()) };
  }
  // 10-20 在 test-4 驗過:直接開到「地區」視窗(app 只開視窗,不改設定)
  function openRegion() {
    if (!win()) return { code: "NOT_WINDOWS" };
    try { const c = spawnFn(sys32(systemRoot, "control.exe"), ["intl.cpl"], { detached: true, stdio: "ignore" }); if (c && c.on) c.on("error", () => { }); if (c && c.unref) c.unref(); return { code: "OK" }; } catch (_) { return { code: "START" }; }
  }
  async function pickPfx() {
    if (!win()) return { code: "NOT_WINDOWS" };
    let p = null; try { p = await pickFile(); } catch (_) { return { code: "READ_FAILED" }; }
    if (!p) return { code: "CANCELED" };
    if (typeof p !== "string" || !path.isAbsolute(p) || !/\.(pfx|p12)$/i.test(p)) return { code: "PFX_INVALID" };
    let size = 0; try { size = fs.statSync(p).size; } catch (_) { return { code: "READ_FAILED" }; }
    if (!(size > 0)) return { code: "READ_FAILED" };
    if (size > PFX_MAX_BYTES) return { code: "PFX_TOO_LARGE" };
    picked = p;
    return { code: "OK" };
  }
  async function importPfx(pw) {
    if (!win()) return { code: "NOT_WINDOWS" };
    if (!picked) return { code: "READ_FAILED" };
    if (typeof pw !== "string" || !PFX_PW_RE.test(pw)) return { code: "PFX_PASSWORD" };
    const stdin = Buffer.from(JSON.stringify({ p: picked, pw }), "utf8").toString("base64") + "\n";
    const r = await ps(PS_IMPORT, { stdin, timeoutMs: 90000 });
    let j = null; try { j = JSON.parse(String(r.out).trim()); } catch (_) { }
    const code = j && PFX_CODES.indexOf(j.code) >= 0 ? j.code : "IMPORT_FAILED";
    if (code === "OK") picked = null;
    return code === "OK" || code === "NO_KEY" ? { code, expiry: ymd(j.exp) } : { code };
  }
  // 關框:選好的檔與快照丟掉;精靈不管(detached,用戶可能還在裡面)
  function forget() { picked = null; snapshot = null; return true; }

  /* 刪舊證:plan 只數、remove 真的刪(確認框按了之後)。回給畫面的只有張數與留下那張的到期日 */
  async function oldCerts(remove) {
    if (!win()) return { code: "NOT_WINDOWS" };
    const r = await ps(PS_OLD, remove ? { env: { CAPL_DO: "1" } } : undefined);
    let j = null; try { j = JSON.parse(String(r.out).trim()); } catch (_) { }
    if (r.rc !== 0 || !j || !Number.isInteger(j.n)) return { code: "FAILED" };
    return { code: "OK", n: j.n, keep: j.keep ? ymd(j.keep) : null };
  }

  /* 身分證字號與交易密碼:safeStorage(Windows = DPAPI)存在 userData 的 capital.bin,只有這個行程解得開;要用時用 daemon 的
     secret 封裝成 capital_local 指令。renderer 送進來一次、拿不回去(info 只講存了沒有;身分證不出這個行程)。不 log、不進埋點 */
  const storePath = path.join(userData, "capital.bin");
  let lastResend = 0;
  function load() {
    try {
      if (!seal || !seal.available()) return null;
      const d = JSON.parse(seal.decrypt(fs.readFileSync(storePath)));
      return d && d.kind === "capital" && ID_RE.test(d.id) && PW_RE.test(d.pw) ? d : null;
    } catch (_) { return null; }
  }
  function write(d) {
    fs.mkdirSync(userData, { recursive: true });
    const tmp = storePath + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(tmp, seal.encrypt(JSON.stringify({ kind: "capital", id: d.id, pw: d.pw })), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
  }
  function info() { return { saved: !!load(), windows: win() }; }
  function forgetCreds() { try { fs.unlinkSync(storePath); } catch (_) { } return true; }
  // 解除綁定:帳密檔、留在 userData 的精靈(spec §2.2:沒有敏感資料,收乾淨)、這次開框選的檔與快照
  function unbound() { forgetCreds(); forget(); sigOk = null; try { fs.unlinkSync(wizPath); } catch (_) { } return true; }
  const codeOf = (err) => { const m = /^(?:\w+: )?([A-Z][A-Z_]+)(?::|$)/.exec(String(err || "")); return m ? m[1] : "FAILED"; };
  async function send(op, extra, timeoutMs) {
    const h = host();
    if (!h) return { code: "DAEMON_DOWN" };
    const r = await h.send("capital_local", Object.assign({ op }, extra || {}), { trusted: true, timeoutMs });
    if (r && r.ok) return { code: "OK", result: r.result };
    if (r && r.error === "UNKNOWN_RESULT") return { code: "SENT" };   // 長步驟:daemon 收走了,結果看狀態檔
    return { code: codeOf(r && r.error) };
  }
  function sealed(d) { const h = host(); return h && typeof h.sealCapital === "function" ? h.sealCapital({ id: d.id, pw: d.pw }) : null; }
  /* 表單「開始開通」/ 改交易密碼:存起來 → bind(.env 只寫 sentinel,真的值留在 daemon 記憶體)。格式不對不存 */
  async function connect(a) {
    if (!win()) return { code: "NOT_WINDOWS" };
    // id null = 改交易密碼:身分證用存著的那個(畫面沒有,也拿不回去)
    const keep = a && a.id === null ? load() : null;
    const id = keep ? keep.id : a && typeof a.id === "string" ? a.id.trim().toUpperCase() : "", pw = a && typeof a.pw === "string" ? a.pw : "";
    if (!ID_RE.test(id)) return { code: "BAD_ID" };
    if (!PW_RE.test(pw)) return { code: "BAD_PW" };
    if (!seal || !seal.available()) return { code: "NO_SEAL" };
    const blob = sealed({ id, pw });
    if (!blob) return { code: "DAEMON_DOWN" };
    const r = await send("bind", { sealed: blob }, 20000);
    if (r.code === "OK" || r.code === "SENT") { write({ id, pw }); lastResend = now(); }
    return { code: r.code };
  }
  async function step(name, opts) {
    if (!win()) return { code: "NOT_WINDOWS" };
    if (OPS.indexOf(name) < 0) return { code: "BAD_ARGS" };
    const extra = name === "probe" && opts && opts.afterUnlock === true ? { after_unlock: true } : {};
    return send(name, extra, name === "stop" ? 10000 : 4000);
  }
  /* daemon 每次起來都是空手:.env 綁著群益、daemon 說還沒拿到 → 存著的那組再交一次(主行程 5 秒那一輪叫) */
  async function resync(report) {
    const cl = report && report.capital_local, v = report && report.venues && report.venues.capital;
    if (!cl || cl.secrets || !(v && v.credentials)) return null;
    if (now() - lastResend < RESEND_EVERY_MS) return null;
    const d = load(); if (!d) return null;
    const blob = sealed(d); if (!blob) return null;
    lastResend = now();
    return send("secrets", { sealed: blob }, 10000);
  }
  return { scan, openWizard, locale, openRegion, pickPfx, importPfx, forget, oldCerts, info, connect, step, resync, forgetCreds, unbound, _load: load };
}
module.exports = { createCapitalLocal, sys32, sealFor, parseList, parseAcp, winNames, ymd, PS_LIST, PS_KEYSIGN, PS_SIG, PS_IMPORT, PS_OLD, ID_RE, PW_RE,
  WIZ_URL, WIZ_HEADERS, WIZ_SHA256, WIZ_SIGNER, CERT_ZONE_URL };
