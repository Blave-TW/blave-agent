// shell/agentrules.js:設定 › Agent 規則讀寫這台電腦的 state/preferences.md 與 state/reply_lang。
// 守四件:讀寫往返(讀的是 runtime 的 python 解析)、超過上限拒絕、壞檔不被覆蓋(讀不到 ≠ 空)、
// 比對後才寫(畫面依據的 base ≠ 磁碟 → RULES_CHANGED,不寫)。畫面那一半的競態在 tests/check_shell_rules_races.js。
// 寫入的真 daemon 那一段在 tests/check_shell_daemon.js;這裡的寫入照 command_listener._cmd_preferences_set 的格式落檔。
// 一律用暫存 workspace,不碰 ~/Blave。跑法:node tests/check_shell_agent_rules.js(需要 python3)
const fs = require("fs"), os = require("os"), path = require("path");
const A = require("../shell/agentrules.js"), { argsOk } = require("../shell/daemon.js");
const ROOT = path.join(__dirname, ".."), WS = fs.mkdtempSync(path.join(os.tmpdir(), "blave-ar-")), ST = path.join(WS, "state");
const PREFS = path.join(ST, "preferences.md"), LANGF = path.join(ST, "reply_lang");
let red = 0; const t = (n, ok, extra) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || extra === undefined ? "" : "  → " + JSON.stringify(extra))); if (!ok) red++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 讀的是 runtime/*.py 的私有複本:「讀不寫 __pycache__」看這份有沒有長出 __pycache__。直接看 repo 的 runtime/__pycache__ 會把
// 同一棵樹上別的行程(開發版的 daemon、並行的測試)剛好在這幾秒補寫的 pyc 算到這支頭上——合併後 pyc 過期時第一次跑紅、重跑綠
const RT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "blave-ar-rt-")), "runtime");
fs.mkdirSync(RT);
for (const n of fs.readdirSync(path.join(ROOT, "runtime"))) if (n.endsWith(".py")) fs.copyFileSync(path.join(ROOT, "runtime", n), path.join(RT, n));
const read = () => A.readLocal({ python: process.env.BLAVE_TEST_PYTHON || "python3", runtimeDir: RT, workspace: WS,
  env: { PATH: process.env.PATH, HOME: os.homedir() } });
const writes = []; let lastArgs = null;
const saveRules = async (rules) => R.save("preferences_set", { rules, base: (await R.read()).rules });
const R = A.createAgentRules({
  readLocal: read, argsOk,
  writeLocal: async (cmd, args) => {   // = command_listener 的落檔格式
    writes.push(cmd); lastArgs = args;
    fs.mkdirSync(ST, { recursive: true });
    if (cmd === "preferences_set") { fs.writeFileSync(PREFS, args.rules.map((r) => "- " + r.trim() + "\n").join("")); return { ok: true, result: { rules: args.rules } }; }
    if (args.lang) fs.writeFileSync(LANGF, args.lang + "\n"); else if (args.custom) fs.writeFileSync(LANGF, "custom:" + args.custom + "\n"); else fs.rmSync(LANGF, { force: true });
    return { ok: true, result: { lang: args.lang, custom: args.custom || "" } };
  },
});

(async () => {
  // ---- 讀寫往返 ----
  t("沒有檔:0 條、自動(不是讀不到)", eq(await R.read(), { rules: [], replyLang: { lang: "", custom: "" }, langReadable: true }));
  t("存兩條規則 → 讀回同一份", (await saveRules(["每個策略都要設停損", "回測至少三年"])).ok
    && eq((await R.read()).rules, ["每個策略都要設停損", "回測至少三年"]));
  t("回覆語言:自訂 → 讀回;清掉 → 自動", (await R.save("reply_lang_set", { lang: "", custom: "Deutsch" })).ok && eq((await R.read()).replyLang, { lang: "", custom: "Deutsch" })
    && (await R.save("reply_lang_set", { lang: "", custom: "" })).ok && eq((await R.read()).replyLang, { lang: "", custom: "" }));
  fs.writeFileSync(PREFS, "# 我的偏好\r\n* 回測至少三年\r\n散文\n1. 不超過 3 倍槓桿  \n   - 縮排三格也算\n    - 四格不算\n");
  t("agent 手寫的檔:照 api _parse_rules 讀(四種條列、CRLF、標題與散文略過,不截字)", eq((await R.read()).rules, ["回測至少三年", "不超過 3 倍槓桿", "縮排三格也算"]));
  fs.writeFileSync(PREFS, Array.from({ length: 12 }, (_, i) => "- r" + i + "\n").join("") + "- " + "字".repeat(200) + "\n");
  const over = await R.read();
  t("agent 寫超過 10 條、單條 200 字:照原文全部讀出來", over.rules.length === 13 && over.rules[12].length === 200);

  // ---- 超過上限拒絕(傳輸天花板 100 條 × 1000 字;介面的 10 × 150 在 renderer/rules.js)----
  writes.length = 0;
  const big = [await saveRules(Array.from({ length: 101 }, (_, i) => "r" + i)),
    await saveRules(["字".repeat(1001)]), await saveRules(["a\nb"]),
    await saveRules(Array.from({ length: 17 }, () => "字".repeat(950))),   // 每條都合格、總長超過讀取上限 16000 字
    await R.save("preferences_set", { rules: ["r"] }), await R.save("preferences_set", { rules: ["r"], base: "r" }),
    await R.save("reply_lang_set", { lang: "", custom: "字".repeat(41) }), await R.save("reply_lang_set", { lang: "de", custom: "" })];
  t("超過上限 / 總長會讓檔讀不回來 / 夾帶換行 / 沒帶 base / 不認得的語言:拒絕(BAD_ARGS),什麼都沒寫", big.every((r) => r.ok === false && r.error === "BAD_ARGS") && writes.length === 0);
  t("超限態刪得掉:12 條 → 送 11 條照收", (await saveRules(over.rules.slice(0, 11))).ok && (await R.read()).rules.length === 11);

  // ---- 比對後才寫 ----
  const before = fs.readFileSync(PREFS); writes.length = 0;
  const stale = await R.save("preferences_set", { rules: ["r0", "新的一條"], base: ["r0"] });
  t("畫面依據的 base 跟磁碟上不一樣:回 RULES_CHANGED 帶磁碟上的那份,不寫",
    stale.ok === false && stale.error === "RULES_CHANGED" && stale.state && stale.state.rules.length === 11 && writes.length === 0 && fs.readFileSync(PREFS).equals(before), stale);
  const cas = await R.save("preferences_set", { rules: ["只剩這條"], base: stale.state ? stale.state.rules : [] });
  t("base 相同:照寫,交給 daemon 的只有 { rules }(argsOk 只收一個 key)", cas.ok && eq(writes, ["preferences_set"]) && eq(Object.keys(lastArgs), ["rules"]) && eq((await R.read()).rules, ["只剩這條"]));
  fs.writeFileSync(PREFS, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("- 帶 BOM 的第一條\n- 第二條\n")]));
  t("帶 BOM 的檔(PowerShell Set-Content):第一條照樣讀得到", eq((await R.read()).rules, ["帶 BOM 的第一條", "第二條"]));
  t("只收這兩個指令", (await R.save("resume", {})).error === "NOT_ALLOWED");
  const rs = fs.readFileSync(path.join(ROOT, "shell", "renderer", "rules.js"), "utf8");
  t("介面的閘門是 10 條 × 150 字(同 web 工作頁 RULES_MAX / RULES_LEN、runtime 對 agent 講的 10 條)", /const RULES_MAX = 10, RULES_LEN = 150,/.test(rs));

  // ---- 壞檔不被覆蓋(讀不到 ≠ 空)----
  const astral = "\u{1F600}".repeat(25);   // 25 個字、50 個 UTF-16 單位
  t("自訂語言用字數算上限(代理對算一個字):25 個 emoji 不算超長", (await R.save("reply_lang_set", { lang: "", custom: astral })).ok && (await R.read()).replyLang.custom === astral);
  for (const [name, bytes] of [["不是 UTF-8", Buffer.from([0x2d, 0x20, 0xff, 0xfe, 0x0a])], ["超過 16000 字", Buffer.from("- x\n".repeat(4001))]]) {
    fs.writeFileSync(PREFS, bytes); writes.length = 0;
    const r = await R.read(), w = await R.save("preferences_set", { rules: ["新規則"], base: [] });
    t(`壞檔(${name}):讀回 null(不是 0 條)、存檔拒絕、檔案位元組不變`, r.rules === null && w.ok === false && w.error === "RULES_UNREADABLE" && writes.length === 0 && fs.readFileSync(PREFS).equals(bytes));
  }
  t("規則檔壞了不擋回覆語言", (await R.save("reply_lang_set", { lang: "en", custom: "" })).ok && (await R.read()).replyLang.lang === "en");
  fs.writeFileSync(LANGF, "klingon??\n");
  t("回覆語言檔有內容卻讀不出設定:畫面照「自動」,並標 langReadable false", eq((await R.read()).replyLang, { lang: "", custom: "" }) && (await R.read()).langReadable === false);

  const pyc = path.join(RT, "__pycache__");   // 自訂語言那條還會 import session_store
  t("讀不寫 __pycache__(打包版的 runtime 在簽過章的 .app 裡)", !fs.existsSync(pyc), fs.existsSync(pyc) ? fs.readdirSync(pyc) : undefined);

  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(path.dirname(RT), { recursive: true, force: true });
  console.log(red ? `\n${red} FAILED` : "\nALL PASS");
  process.exit(red ? 1 : 0);
})();
