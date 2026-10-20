// 群益本機的憑證那一段 — 畫面的狀態機(shell/renderer/capital_local.js 的純邏輯段,從原文切出來跑)+ 原文的幾條規矩。
//   列舉每一種組合 → 設計 mockup 的哪一態;每一態的腳(提醒那一格、還是要開、主鈕、取消鈕的字);系統地區不是繁中時沒有主鈕;
//   雲端已連群益只換提醒那一句、主鈕照常;埋點名字在白名單裡、「還是要開」只在精靈真的打開時記;畫面這層碰不到 thumbprint / 身分證 / 檔名。
// 跑法:node tests/check_shell_capital_local_view.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const file = path.join(__dirname, "..", "shell", "renderer", "capital_local.js"), src = fs.readFileSync(file, "utf8");
const a = src.indexOf("/* ── 純邏輯"), b = src.indexOf("/* ── 純邏輯到此 ── */");
let red = 0; const ok = (n, c, got) => { console.log((c ? "PASS  " : "FAIL  ") + n); if (!c) { red++; if (got !== undefined) console.log("      got: " + JSON.stringify(got)); } };
if (a < 0 || b < 0) { console.log("FAIL  capital_local.js 找不到純邏輯段的記號"); process.exit(1); }
const head = src.slice(0, src.indexOf("let CAPL = caplBlank();"));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(head + "\n" + src.slice(a, b) + "\nthis.caplView = caplView; this.caplFootSpec = caplFootSpec; this.caplBlank = caplBlank; this.caplCloudOn = caplCloudOn; this.CAPL_FEATURE = CAPL_FEATURE;", ctx);
const { caplView, caplFootSpec, caplCloudOn } = ctx;
const W = { win: true };
const ui = (o) => Object.assign(ctx.caplBlank(), o || {});
const NONE = { usable: 0, expiry: null, expired: null }, EXP = { usable: 0, expiry: null, expired: "2026/10/12" };
const LOC_BAD = { ok: false, names: "en" }, LOC_OK = { ok: true, names: "en" }, LOC_UNK = { ok: null, names: "en" };
const v = (o, x) => caplView(ui(o), x || W);

// 設計 spec §3 的 29 態裡這一段要做的(l-cloud-warn-b 是 Wei 沒選的 B;l-flow / l-old-* / w-dual 是下一段)
const CASES = [
  ["m-mac", {}, { win: false }],
  ["l-cert-load", {}],
  ["l-cert-none", { scan: NONE }],
  ["l-cert-new", { scan: NONE, choice: "new" }],
  ["l-cert-new", { scan: NONE, choice: "new", loc: LOC_OK }],
  ["l-cert-new", { scan: NONE, choice: "new", loc: LOC_UNK }],   // 讀不到系統地區:不擋
  ["l-cloud-warn", { scan: NONE, choice: "new", cloud: true }],
  ["l-cert-have", { scan: NONE, choice: "have" }],
  ["l-cert-have", { scan: NONE, choice: "have", loc: LOC_BAD }],   // 匯入不受系統地區影響
  ["l-cert-picked", { scan: NONE, choice: "have", picked: true }],
  ["l-cert-picked", { scan: NONE, choice: "have", picked: true, pfxErr: "PFX_NOT_CAPITAL" }],   // 檔案類的錯畫在卡下,不是密碼欄
  ["l-cert-picked-err", { scan: NONE, choice: "have", picked: true, pfxErr: "PFX_PASSWORD" }],
  ["l-cert-expired", { scan: EXP }],   // 預設停在展延
  ["l-cert-expired", { scan: EXP, choice: "renew" }],
  ["l-cert-expired-have", { scan: EXP, choice: "have" }],
  ["l-cert-expired-cloud", { scan: EXP, cloud: true }],
  ["l-cert-expired-locale", { scan: EXP, loc: LOC_BAD }],
  ["l-cert-expired-locale", { scan: EXP, loc: LOC_BAD, cloud: true }],
  ["l-locale", { scan: NONE, choice: "new", loc: LOC_BAD }],
  ["l-locale", { scan: NONE, choice: "new", loc: { ok: false, names: "zh" } }],   // l-locale-zhwin:同一態,字串來源不同
  ["l-wiz", { scan: NONE, choice: "new", wiz: true }],
  ["l-wiz-busy", { scan: NONE, choice: "new", wiz: true, err: "busy" }],
  ["l-cert-new", { scan: NONE, choice: "new", wiz: false }],   // l-wiz-none:精靈關了、沒有新證 = 回到這一頁、分段鈕停在申請新憑證
  ["l-err-dl", { scan: NONE, choice: "new", err: "dl" }],
  ["l-err-sig", { scan: NONE, choice: "new", err: "sig" }],
  ["l-err-launch", { scan: NONE, choice: "new", err: "launch" }],
  ["l-cert-expired", { scan: EXP, err: "dl" }],   // 過期頁的錯行疊在同一頁
  ["l-locale", { scan: NONE, choice: "new", loc: LOC_BAD, err: "launch" }],   // 「還是要開」之後失敗:錯行疊在系統地區頁
  ["l-nokey", { scan: NONE, choice: "new", nokey: true, wiz: false }],
  ["l-nokey", { scan: NONE, choice: "have", picked: true, nokey: true }],
  ["l-form", { scan: { usable: 1, expiry: "2027/10/20", expired: null }, done: "2027/10/20" }],
  ["l-form", { scan: NONE, choice: "new", wiz: false, done: "2027/10/20" }],
];
for (const [want, o, x] of CASES) ok(`${want} ← ${JSON.stringify(o)}`, v(o, x) === want, v(o, x));
const SEGMENT = ["m-mac", "l-cert-load", "l-cert-none", "l-cert-new", "l-cloud-warn", "l-cert-have", "l-cert-picked", "l-cert-picked-err", "l-cert-expired",
  "l-cert-expired-have", "l-cert-expired-cloud", "l-cert-expired-locale", "l-locale", "l-wiz", "l-wiz-busy", "l-err-dl", "l-err-sig", "l-err-launch", "l-nokey", "l-form"];
ok("這一段的每一態都列舉到了", SEGMENT.every((s) => CASES.some((c) => c[0] === s)));

// 全組合:每一種都落在這一段的態名裡(沒有 undefined、沒有半成品名字)
{ const seen = new Set(); let stray = null;
  for (const win of [true, false]) for (const scan of [null, NONE, EXP]) for (const choice of [null, "new", "renew", "have"]) for (const loc of [null, LOC_OK, LOC_BAD, LOC_UNK])
    for (const cloud of [false, true]) for (const wiz of [false, true]) for (const err of [null, "dl", "sig", "launch", "busy"]) for (const picked of [false, true])
      for (const pfxErr of [null, "PFX_PASSWORD", "PFX_OLDER"]) for (const nokey of [false, true]) for (const done of [null, "2027/10/20"]) {
        const s = caplView(ui({ scan, choice, loc, cloud, wiz, err, picked, pfxErr, nokey, done }), { win }); seen.add(s);
        if (SEGMENT.indexOf(s) < 0) stray = s;
        const f = caplFootSpec(s, ui({ cloud }));
        if (/locale/.test(s) && (f.go || !f.anyway)) stray = "locale-with-go:" + s;
        if (f.go && !(f.msg || /have|picked/.test(s))) stray = "go-without-msg:" + s;
      }
  ok("全組合都落在這一段的態名裡", stray === null, stray);
  ok("全組合摸得到這一段的每一態", SEGMENT.every((s) => seen.has(s)), SEGMENT.filter((s) => !seen.has(s))); }

// 腳
const F = (s, cloud) => JSON.stringify(caplFootSpec(s, ui({ cloud: !!cloud })));
ok("l-cert-none:沒有主鈕、只有稍後再來", F("l-cert-none") === JSON.stringify({ msg: null, anyway: false, go: null, cancel: "pres.later" }));
ok("l-cert-new:撤銷提醒 + 稍後再來 + 開啟憑證精靈", F("l-cert-new") === JSON.stringify({ msg: "revoke", anyway: false, go: "capl.open", cancel: "pres.later" }));
ok("l-cloud-warn:同一格換雲端那句,主鈕照常可按(不擋)", F("l-cloud-warn", true) === JSON.stringify({ msg: "cloud", anyway: false, go: "capl.open", cancel: "pres.later" }));
ok("過期頁:一樣的腳(展延走同一個精靈、一樣會撤銷);雲端已連也換那句", F("l-cert-expired") === F("l-cert-new") && F("l-cert-expired-cloud", true) === F("l-cloud-warn", true));
ok("錯行那三態:腳不變(主鈕就是再試一次)", ["l-err-dl", "l-err-sig", "l-err-launch"].every((s) => F(s) === F("l-cert-new")));
ok("系統地區頁:沒有主鈕;提醒那一格還在;腳左側「還是要開」", F("l-locale") === JSON.stringify({ msg: "revoke", anyway: true, go: null, cancel: "pres.later" })
  && F("l-cert-expired-locale", true) === JSON.stringify({ msg: "cloud", anyway: true, go: null, cancel: "pres.later" }));
ok("已經有憑證:主鈕選擇憑證檔案;選好檔:主鈕匯入;都沒有撤銷提醒(匯入不撤銷)", JSON.parse(F("l-cert-have")).go === "capl.pick" && JSON.parse(F("l-cert-expired-have")).go === "capl.pick"
  && JSON.parse(F("l-cert-picked")).go === "capl.import" && JSON.parse(F("l-cert-picked-err")).go === "capl.import" && [ "l-cert-have", "l-cert-picked"].every((s) => JSON.parse(F(s)).msg === null));
ok("精靈開著 / 找憑證中 / 找到了 / Mac:只有取消;私鑰用不了:只有關閉(不給再申請)", ["l-wiz", "l-wiz-busy", "l-cert-load", "l-form", "m-mac"].every((s) => F(s) === JSON.stringify({ msg: null, anyway: false, go: null, cancel: "del.cancel" }))
  && F("l-nokey") === JSON.stringify({ msg: null, anyway: false, go: null, cancel: "set.close" }));

// 雲端已連群益
ok("雲端:帳密綁著、或下單程式起來過 → 已連;讀不到 → 沒有", caplCloudOn({ venues: { capital: { credentials: true } } }) === true && caplCloudOn({ capital_connect: { worker: { status: "ok" } } }) === true
  && caplCloudOn({ capital_connect: { worker: { status: "failed" } } }) === false && caplCloudOn(null) === false && caplCloudOn({}) === false);

// 原文的規矩
const tel = fs.readFileSync(path.join(__dirname, "..", "shell", "telemetry.js"), "utf8");
ok("埋點四個名字都在 feature_used 白名單、都 ≤16 字", Object.values(ctx.CAPL_FEATURE).every((n) => tel.includes(`"${n}"`) && n.length <= 16 && /^capl_/.test(n)));
{ const ow = src.slice(src.indexOf("async function caplOpenWizard("), src.indexOf("function caplChoose("));
  ok("capl_wiz_open / capl_wiz_anyway 只在主行程回 OK 時記(失敗不埋)", /if \(code === "OK"\) \{ CAPL\.wiz = true; caplTrack\("wiz"\); if \(anyway\) caplTrack\("anyway"\);/.test(ow) && (ow.match(/caplTrack\(/g) || []).length === 2);
  ok("「還是要開」走 caplOpenWizard(true),主鈕走 caplOpenWizard(false)", /caplOpenWizard\(true\)/.test(src.slice(src.indexOf("function caplFoot("), src.indexOf("function caplSyncGo(")))
    && /if \(s\.go === "capl\.open"\) return caplOpenWizard\(false\);/.test(src)); }
{ const sc = src.slice(src.indexOf("async function caplScanNow("), src.indexOf("function caplWatch("));
  ok("新證而且私鑰用得了才記 capl_cert_new;用不了 → nokey(不記)", /if \(r\.keyOk\) \{ CAPL\.done = r\.expiry \|\| "—"; caplTrack\("fresh"\); \} else CAPL\.nokey = true;/.test(sc));
  ok("精靈關了、這次沒認出新證(快照丟過),但庫裡有能用的 → 到帳密(不讓他再申請一次)", /CAPL\.wiz = false; CAPL\.err = null; caplWatch\(false\);\n[^\n]*\n\s+if \(ok && r\.usable > 0\) CAPL\.done = r\.expiry \|\| "—";/.test(sc));
  ok("找到能用的憑證就直接到帳密、停止輪詢(不用「我完成了」鈕)", /else if \(!CAPL\.wiz && ok && r\.usable > 0\) \{ CAPL\.done = r\.expiry \|\| "—"; caplWatch\(false\); \}/.test(sc)); }
ok("輪詢:框關了或換交易所 / 換視角就停", /if \(\$\("cx-scrim"\)\.hidden \|\| CXF\.venue !== CAPITAL \|\| CXF\.env !== "local"\) return caplWatch\(false\);/.test(src));
ok("畫面這層碰不到 thumbprint / 身分證 / 檔名(沒有那些欄位)", !/thumb|\.cn\b|subject|filePath|\.name\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
ok("匯出密碼送出後就清掉", /if \(code === "OK"\) \{ CAPL\.ppw = "";/.test(src) && /else if \(code === "NO_KEY"\) \{ CAPL\.ppw = "";/.test(src));
ok("地區設定的選單名不進 .po(兩組常數)、繁中介面那組是中文", /const CAPL_WIN_NAMES = \{/.test(src) && JSON.parse(JSON.stringify(eval("(" + src.slice(src.indexOf("const CAPL_WIN_NAMES = ") + 23, src.indexOf("};", src.indexOf("const CAPL_WIN_NAMES = ")) + 1) + ")"))).zh.cp === "控制台");
{ const strings = fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "strings.js"), "utf8");
  const keys = [...new Set([...src.matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]).concat([...src.matchAll(/"(capl\.[\w.]+|cap\.[\w.]+|pres\.[\w.]+)"/g)].map((m) => m[1])))];
  const zh = strings.split("\n  zh: {")[1], en = strings.split("\n  zh: {")[0];
  const miss = keys.filter((k) => !en.includes(`"${k}":`) || !zh.includes(`"${k}":`));
  ok("用到的字串兩語都有(含 key 表裡的)", miss.length === 0, miss);
  const zhOf = (k) => (zh.match(new RegExp(`"${k.replace(/\./g, "\\.")}": "([^"]*)"`)) || [])[1];
  ok("zh 用全形標點(沒有半形冒號、逗號)", keys.filter((k) => /^capl\./.test(k)).every((k) => !/[:,]/.test(zhOf(k) || "")), keys.filter((k) => /[:,]/.test(zhOf(k) || ""))); }
ok("trade.js:群益本機受 CAPL_LOCAL_ON 管、預設關;雲端那條不動", /^const CAPL_LOCAL_ON = false;$/m.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8"))
  && /if \(CXF\.venue === CAPITAL && CXF\.env === "cloud"\) return capPaint\(\);/.test(fs.readFileSync(path.join(__dirname, "..", "shell", "renderer", "trade.js"), "utf8")));

console.log(red ? `\n${red} FAILED` : "\nall passed");
process.exit(red ? 1 : 0);
