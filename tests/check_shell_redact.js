// 對話上傳前的遮蔽(shell/redact.js,spec mobile-agent-chat-mvp §4.3)。
//   1. 共用 fixture 每一則逐字等於 out(api openclaw/redact.py 跑同一份)
//   2. 兩份 fixture 逐字相同(要 monorepo 版面 ../api,或 BLAVE_API_DIR;找不到 SKIP)
//   3. 第 6 條的 HOME_RE、LONG_TOKEN_RE 用的是 mobileview.js 那組 regex 物件本身
//   4. BIP-39 字表 2048 字、等於上游那份
//   5. 6 萬字的長串每一種都 < 1 秒(名=值、網址 query 都是線性寫法;超過 INPUT_MAX 的只看前 64K 字)
//   6. .env 取值:像秘密的鍵與像金鑰的值才收,*_DEMO 與短值不收
// 跑法:node tests/check_shell_redact.js
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const SHELL = path.join(__dirname, "..", "shell");
const R = require(path.join(SHELL, "redact.js")), MV = require(path.join(SHELL, "mobileview.js"));
const FIX = path.join(__dirname, "fixtures", "redact_cases.json");
let red = 0; const ok = (n, c, d) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + JSON.stringify(d))); if (!c) red++; };

const fx = JSON.parse(fs.readFileSync(FIX, "utf8"));
ok("記號同 fixture", fx.mask === R.MASK && fx.excluded === R.EXCLUDED, [fx.mask, fx.excluded]);
for (const c of fx.cases) {
  const got = R.redact(c.in, c.known);
  ok(`1 第 ${c.rule} 條 ${c.name}`, got === c.out, { got, want: c.out });
}
for (let rule = 1; rule <= 7; rule++) {
  const cs = fx.cases.filter((c) => c.rule === rule);
  const masked = cs.filter((c) => c.out !== c.in), kept = rule === 7 ? cs.filter((c) => c.out !== R.EXCLUDED) : cs.filter((c) => c.out === c.in);
  ok(`1 第 ${rule} 條該遮與不該遮都有`, masked.length > 0 && kept.length > 0, cs.map((c) => c.name));
}

const apiFix = path.join(process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api"), "tests", "fixtures", "redact_cases.json");
if (!fs.existsSync(apiFix)) console.log("SKIP  2 fixture 兩端逐字比對(需要 ../api 或 BLAVE_API_DIR)");
else ok("2 fixture 與 api 那份逐字相同", fs.readFileSync(apiFix).equals(fs.readFileSync(FIX)), apiFix);

const rsrc = fs.readFileSync(path.join(SHELL, "redact.js"), "utf8");
ok("3 第 6 條 import mobileview 的 HOME_RE、LONG_TOKEN_RE(不另寫一份)", /require\("\.\/mobileview"\)/.test(rsrc)
  && ["HOME_RE", "LONG_TOKEN_RE"].every((n) => MV[n] instanceof RegExp && !new RegExp("const " + n + " =").test(rsrc)));
{ // 換掉 mobileview 那組的行為,redact 跟著變 = 用的是同一個物件
  const out = R.redact("在 /Users/wei/x 裡");
  ok("3 使用者資料夾照 mobileview 的 HOME_RE 遮", out === "在 ~/x 裡", out);
}

const lines = fs.readFileSync(R.WORDS_PATH, "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
ok("4 BIP-39 2048 字", lines.length === 2048, lines.length);
ok("4 等於上游 english.txt", crypto.createHash("sha256").update(lines.join("\n") + "\n").digest("hex") === "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");

const N = 60000;   // 要小於 INPUT_MAX(64K):超過的部分會先切掉,結尾的 ? 或 = 就測不到
for (const [name, text] of [["全 a", "a".repeat(N)], ["純 hex", "0123456789abcdef".repeat(N / 16)], ["eyJ 重複", "eyJ".repeat(N / 3)],
  ["eyJ 加點重複", "eyJa.".repeat(N / 5)], ["鍵名＝值重複", "key=".repeat(N / 4)], ["一長串名字字元接 =", "a".repeat(N) + "=x"],
  ["名字字元夾冒號", "a_key:".repeat(N / 6)], ["助記詞字重複", "abandon ".repeat(N / 8)], ["斜線", "/".repeat(N)], ["使用者資料夾重複", "/Users/".repeat(N / 7)],
  ["路徑字判斷:a 接一串數字再接 =", "a" + "1".repeat(N) + "="], ["路徑字判斷:x/a 接一串數字再接 =(api 那條指數級的輸入)", "x/a" + "1".repeat(N) + "="], ["路徑字判斷:camelCase 重複接 +", "aB1".repeat(N / 3) + "+"], ["名字段重複不含關鍵字", "note=".repeat(N / 5)],
  ["網址 query:http:// 重複(api 那兩條 regex 6 秒的輸入)", "http://".repeat(N / 7) + "?"], ["網址 query:=/ 重複", "=/".repeat(N / 2) + "?"], ["一堆短串最後才有 ?", "a ".repeat(N / 2) + "?"],
  ["名字含關鍵字接一長串空白", "key" + " ".repeat(N) + "="]]) {
  const t0 = process.hrtime.bigint(); R.redact(text, ["Xy7Qw2Lp9Zr4"]); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(`5 ${name} ${text.length} 字 < 1 秒`, ms < 1000, ms);
}

const env = [
  "BINANCE_API_KEY=Ab12Cd34Ef56", "BINANCE_SECRET_KEY='q1w2e3r4t5y6'", "OKX_PASSPHRASE=\"pass-phrase-1\"", "export PFX_PASSWORD=pfxpass99",   // gitleaks:allow (fake)
  "PRESIDENT_ACCOUNT=9876543", "BINANCE_DEMO=1", "OKX_DEMO=okx_demo_flag", "BYBIT_API_SECRET=short", "# BINANCE_API_KEY=commented",
  "LOG_LEVEL=verbose", "WEBHOOK=Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb", "STRATEGY=binance_funding_rate_strategy_v2_xxxxxx",
].join("\n");
const vals = R.envSecretValues(env);
ok("6 鍵名像秘密、值 ≥ 6 的都收(引號拿掉、export 照認)", ["Ab12Cd34Ef56", "q1w2e3r4t5y6", "pass-phrase-1", "pfxpass99", "9876543"].every((v) => vals.includes(v)), vals);
ok("6 鍵名不像、值像金鑰的也收", vals.includes("Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb"), vals);
ok("6 *_DEMO、短值、註解、一般設定值、策略名不收", !["1", "okx_demo_flag", "short", "commented", "verbose", "binance_funding_rate_strategy_v2_xxxxxx"].some((v) => vals.includes(v)), vals);
ok("N1 不是關鍵字的名=值後面還有一對 key=value:後面那對照遮", R.redact("url=http://x?api_key=abcd1234efgh&a=1").indexOf("abcd1234efgh") < 0);
ok("N2 含 / 的 base64 金鑰整串遮", R.redact("key q8Zt/Kp2+Lm9Wx4Rb7Vn1Yc3Hd6Jf0Gs/Ae5UoIi") === "key ⟦R⟧", R.redact("key q8Zt/Kp2+Lm9Wx4Rb7Vn1Yc3Hd6Jf0Gs/Ae5UoIi"));
// api 的名字段與關鍵字都是 (?i):K(U+212A)、ſ 會摺成 k、s,JS 要 i 加 u 才摺;少一個,名字在這兩個字斷開、值就漏遮。want = api 48377c65 跑同一串的輸出
for (const [t, want] of [["\u212Aey=Ab12Cd34Ef56 ok", "\u212Aey=⟦R⟧ ok"], ["\u017Fecret=q1w2e3r4 ok", "\u017Fecret=⟦R⟧ ok"], ["api_\u212Aey: Zq81mmwx", "api_\u212Aey: ⟦R⟧"]])   // gitleaks:allow (fake)
  ok(`N3 名字含 K／ſ 照 api 的 (?i) 遮:${JSON.stringify(t)}`, R.redact(t) === want, R.redact(t));
// 第 4 條是兩組區間的聯集,一組漏了另一組會補上;兩組各自也要認得這些名字(少一個旗標就紅)
for (const [t, span] of [["\u212Aey=Ab12Cd34Ef56 ok", [4, 16]], ["\u017Fecret=q1w2e3r4 ok", [7, 15]], ["api_\u212Aey: Zq81mmwx", [9, 17]],   // gitleaks:allow (fake)
  ["pr\u0130vate=Ab12Cd34Ef56", [8, 20]], ["pr\u0131vate=Ab12Cd34Ef56", [8, 20]], ["\u0131api_key=abcdef12", [9, 17]]])   // gitleaks:allow (fake)
  for (const k of ["refSpans", "newSpans"]) ok(`N3 ${k} 自己也遮:${JSON.stringify(t)}`, JSON.stringify(R._rule4[k](t)) === JSON.stringify([span]), R._rule4[k](t));
// İ ı:api 的 (?i) 也把它們摺成 i,JS 旗標摺不到,shell 寫進名字段字元類、比關鍵字前換成 i。want 同上是 api 跑出來的
for (const [t, want] of [["pr\u0130vate=Ab12Cd34Ef56", "pr\u0130vate=⟦R⟧"], ["pr\u0131vate=Ab12Cd34Ef56", "pr\u0131vate=⟦R⟧"], ["\u0131api_key=abcdef12", "\u0131api_key=⟦R⟧"]])   // gitleaks:allow (fake)
  ok(`N4 名字含 İ／ı 照 api 遮:${JSON.stringify(t)}`, R.redact(t) === want, R.redact(t));
{ const cfg = R.envSecretValues(["BINANCE_ACCOUNT_TYPE=futures", "OKX_ACCOUNT_MODE=isolated", "BYBIT_ACCOUNT=unified", "PAPER_TOKEN_MODE=paper",
    "GATE_ACCOUNT=Futures", "BITGET_ACCOUNT=futures1", "X_KEY=testnet"].join("\n"));
  ok("6 鍵名像秘密、值是常見設定字(futures、isolated、unified…):不收,這個字不會從每則對話被抹掉", !["futures", "isolated", "unified", "paper", "testnet"].some((v) => cfg.includes(v)), cfg);
  ok("6 只認全小寫原字:大小寫混雜、帶數字的照收", cfg.includes("Futures") && cfg.includes("futures1"), cfg);
  const strict = R.envSecretValues(["OKX_PASSPHRASE=futures", "CAPITAL_PASSWORD=testnet", "BINANCE_SECRET_KEY=isolated", "PRESIDENT_PIN=unified"].join("\n"));
  ok("6 鍵名是 SECRET／PASSPHRASE／PASSWORD／PIN 的:值是設定字也照收", ["futures", "testnet", "isolated", "unified"].every((v) => strict.includes(v)), strict);
  ok("6 設定字照樣出現在遮過的對話裡", R.redact("帳戶是 futures 模式", R.envSecretValues("BINANCE_ACCOUNT_TYPE=futures")) === "帳戶是 futures 模式"); }
ok("6 讀不到 .env(非字串)回空清單", R.envSecretValues(null).length === 0);
ok("6 已知值一併遮、不進輸出", R.redact("key 是 Ab12Cd34Ef56 跟 9876543", vals) === "key 是 ⟦R⟧ 跟 ⟦R⟧");

// 7. 差分語料:api tests/check_redact_differential.py 的生成語料(固定種子)現場跑一次 api 的 redact,每一則電腦版要逐字同一個輸出。
//    語料裡上千把生成的假金鑰,不進版控;要 api checkout(BLAVE_API_DIR 或 ../api)與 python3,找不到就 SKIP。
{ const apiDir = process.env.BLAVE_API_DIR || path.join(__dirname, "..", "..", "api");
  const diff = path.join(apiDir, "tests", "check_redact_differential.py");
  if (!fs.existsSync(diff)) console.log("SKIP  7 差分語料(需要 ../api 或 BLAVE_API_DIR,且有 tests/check_redact_differential.py)");
  else {
    // 只取語料那一段來跑;desktop_portfolio 會 import Flask,這裡只抄它的四個 regex 定義(同 api redact 用的那四個物件)
    const py = String.raw`
import base64, json, os, re, sys, types, random, string
api = sys.argv[1]
src = open(os.path.join(api, "openclaw", "desktop_portfolio.py"), encoding="utf-8").read()
dp = types.ModuleType("openclaw.desktop_portfolio")
for n in ("_HOME_RE", "_URL_QUERY_RE", "_PATH_QUERY_RE", "_LONG_TOKEN_RE"):
    exec([l for l in src.split(chr(10)) if l.startswith(n + " = ")][0], {"re": re}, dp.__dict__)
pk = types.ModuleType("openclaw"); pk.__path__ = [os.path.join(api, "openclaw")]
sys.modules["openclaw"] = pk; sys.modules["openclaw.desktop_portfolio"] = dp
from openclaw import redact as rd
d = open(os.path.join(api, "tests", "check_redact_differential.py"), encoding="utf-8").read()
code = d[d.index("SECRETS = ("):d.index('print(f"語料')]
ns = {"base64": base64, "json": json, "random": random, "string": string}
exec(code, ns)
json.dump([[t, rd.redact(t)] for (t, _k, _s) in ns["corpus"]], sys.stdout, ensure_ascii=False)
`;
    const r = require("child_process").spawnSync(process.env.PYTHON || "python3", ["-I", "-c", py, apiDir], { encoding: "utf8", maxBuffer: 64 << 20 });
    let cases = null; try { cases = JSON.parse(r.stdout); } catch (_) { cases = null; }
    if (!cases) ok("7 差分語料:api 的生成器跑得起來", false, (r.stderr || "").slice(-400));
    else {
      const bad = cases.filter(([t, want]) => R.redact(t) !== want);
      ok(`7 差分語料 ${cases.length} 則:電腦版輸出與 api 逐字相同`, cases.length >= 2000 && bad.length === 0, bad.slice(0, 3).map(([t, want]) => ({ in: t, want, got: R.redact(t) })));
    }
  }
}

console.log(red ? `\n${red} FAIL` : "\nall pass");
process.exit(red ? 1 : 0);
