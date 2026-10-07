// shell/winsandbox.js:Codex elevated 沙盒讀不到隨包 Python 時,把 python-x64 目錄授權給 CodexSandboxUsers。
// 不跑真的 icacls / powershell:execFile 是替身,照呼叫的執行檔回事先排好的結果。跑法:node tests/check_shell_win_sandbox_acl.js
const fs = require("fs"), path = require("path");
const W = require("../shell/winsandbox");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };

const PY = "C:\\Users\\u\\AppData\\Local\\Programs\\Blave\\resources\\python-x64\\python.exe";
const DIR = "C:\\Users\\u\\AppData\\Local\\Programs\\Blave\\resources\\python-x64";
const DEEP = DIR + "\\Lib\\os.py";
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1005";
const NO_ACE = PY + " NT AUTHORITY\\SYSTEM:(I)(F)\r\n    BUILTIN\\Administrators:(I)(F)\r\n    DESKTOP-1\\u:(I)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n";
const WITH_ACE = NO_ACE.replace("DESKTOP-1\\u:(I)(F)", "DESKTOP-1\\u:(I)(F)\r\n    DESKTOP-1\\CodexSandboxUsers:(I)(RX)");

// answers:{ check, deep, ps, grant1, grant2 },各為 { err, out, stderr };沒給的那一步當它成功、沒輸出
function fake(answers, opts = {}) {
  const calls = [];
  const execFile = (bin, args, options, cb) => {
    calls.push({ bin, args, options });
    const step = /powershell\.exe$/.test(bin) ? "ps" : args.length === 1 ? (args[0] === PY ? "check" : "deep") : args.includes("/T") ? "grant2" : "grant1";
    const a = answers[step] || {};
    setImmediate(() => cb(a.err || null, a.out || "", a.stderr || ""));
  };
  const logs = [];
  const acl = W.createSandboxAcl({ win: true, packaged: true, pyExe: PY, exists: (p) => p === PY, execFile, systemRoot: "C:\\WINDOWS", log: (m) => logs.push(m), ...opts });
  return { acl, calls, logs };
}

(async () => {
  {
    const { acl, calls } = fake({}, { win: false });
    t("非 Windows:不呼叫任何東西 → skip", (await acl.ensure()) === "skip" && calls.length === 0);
  }
  {
    const { acl, calls } = fake({}, { packaged: false });
    t("開發版(沒打包):不呼叫任何東西", (await acl.ensure()) === "skip" && calls.length === 0);
  }
  {
    const { acl, calls } = fake({}, { exists: () => false });
    t("沒有隨包 Python:不呼叫任何東西", (await acl.ensure()) === "skip" && calls.length === 0);
  }
  {
    const { acl, calls } = fake({ check: { out: NO_ACE }, ps: { err: Object.assign(new Error("x"), { code: 1 }) } });
    const r = await acl.ensure();
    t("沒有 CodexSandboxUsers 群組(powershell 非 0):不授權 → nogroup,只跑了 icacls 查詢 + powershell", r === "nogroup" && calls.length === 2 && calls.every((c) => !c.args.includes("/grant")));
  }
  {
    const { acl, calls } = fake({ check: { out: NO_ACE }, ps: { out: "garbage\r\n" } });
    t("powershell 回的不是 SID:不授權", (await acl.ensure()) === "nogroup" && !calls.some((c) => c.args.includes("/grant")));
  }
  {
    const { acl, calls } = fake({ check: { out: WITH_ACE } });
    t("python.exe 已有那個群組的 RX:只查一次、不跑 powershell 不授權 → ok", (await acl.ensure()) === "ok" && calls.length === 1);
  }
  {
    const { acl, calls, logs } = fake({ check: { out: NO_ACE }, ps: { out: SID + "\r\n" } });
    const r = await acl.ensure();
    const g = calls.filter((c) => c.args.includes("/grant")).map((c) => c.args);
    t("缺 ACE:兩條 icacls、順序與 argv 逐字對", r === "granted" && g.length === 2
      && JSON.stringify(g[0]) === JSON.stringify([DIR, "/grant", "*" + SID + ":(OI)(CI)RX", "/C", "/Q"])
      && JSON.stringify(g[1]) === JSON.stringify([DIR + "\\*", "/grant", "*" + SID + ":RX", "/T", "/C", "/Q"]));
    t("執行檔是 System32 的絕對路徑(不靠 PATH / cwd)", calls.every((c) => c.bin === "C:\\WINDOWS\\System32\\icacls.exe" || c.bin === "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
    t("每次呼叫都 windowsHide: true、有 timeout", calls.every((c) => c.options.windowsHide === true && c.options.timeout > 0));
    t("log 不帶路徑與 SID", logs.length === 1 && !logs[0].includes("python-x64") && !logs[0].includes(SID));
    const before = calls.length;
    t("同一次啟動第二次 ensure:零呼叫(不每則訊息重掃)", (await acl.ensure()) === "granted" && calls.length === before);
  }
  {
    const { acl, logs } = fake({ check: { out: NO_ACE }, ps: { out: SID }, grant2: { err: Object.assign(new Error("x"), { code: 2 }) } });
    t("授權失敗:resolve 成 fail、記 log、不 throw", (await acl.ensure()) === "fail" && logs.length === 1 && /files: exit 2/.test(logs[0]));
  }
  {
    const execFile = () => { throw new Error("spawn EACCES"); };
    const acl = W.createSandboxAcl({ win: true, packaged: true, pyExe: PY, exists: () => true, execFile, log: () => {} });
    t("execFile 本身丟例外:仍 resolve(fail)", (await acl.ensure()) === "fail");
  }
  // 完成標記看深層檔:/T 中途逾時被砍時 python.exe 可能已有 ACE、標準庫還沒有
  {
    const { acl, calls } = fake({ check: { out: WITH_ACE }, deep: { out: NO_ACE.replace(PY, DEEP) }, ps: { out: SID } }, { exists: (p) => p === PY || p === DEEP });
    t("python.exe 有 ACE、Lib\\os.py 沒有:不算完成,照樣授權", (await acl.ensure()) === "granted" && calls.filter((c) => c.args.includes("/grant")).length === 2);
  }
  {
    const { acl, calls } = fake({ check: { out: WITH_ACE }, deep: { out: WITH_ACE.replace(PY, DEEP) } }, { exists: (p) => p === PY || p === DEEP });
    t("兩個都有 ACE → ok,只查這兩個、不跑 powershell", (await acl.ensure()) === "ok" && calls.length === 2 && calls[1].args[0] === DEEP);
  }
  // 只有 Codex 設了 elevated 才做事;讀不到設定照做
  for (const [cfg, want, label] of [["", "skip", "沒有 Codex 設定檔"], ['model = "gpt-5.5"\n[windows]\nsandbox = "unelevated"\n', "skip", "設的是 unelevated"],
    ['[windows]\nsandbox = "elevated"\n', "ok", "[windows] sandbox = elevated"], ["[features]\nwindows_sandbox_elevated = true\n", "ok", "舊鍵 windows_sandbox_elevated"]]) {
    const { acl, calls } = fake({ check: { out: WITH_ACE } }, { codexConfig: () => cfg });
    const r = await acl.ensure();
    t(`Codex 設定 ${label} → ${want}` + (want === "skip" ? "(零呼叫)" : ""), r === want && (want === "skip" ? calls.length === 0 : calls.length === 1));
  }
  {
    const { acl, calls } = fake({ check: { out: WITH_ACE } }, { codexConfig: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } });
    t("Codex 設定讀不到(不是沒有檔):照做,不跳過", (await acl.ensure()) === "ok" && calls.length === 1);
  }
  // PowerShell 失敗要留 log,而且群組不存在 / PowerShell 跑不起來分得開
  {
    const { acl, logs } = fake({ check: { out: NO_ACE }, ps: { err: Object.assign(new Error("x"), { code: 1 }), stderr: "Exception calling \"Translate\" ...\r\n    + FullyQualifiedErrorId : IdentityNotMappedException\r\n" } });
    t("群組不存在:nogroup,log 寫 not found", (await acl.ensure()) === "nogroup" && logs.length === 1 && /CodexSandboxUsers not found/.test(logs[0]));
  }
  {
    const { acl, logs } = fake({ check: { out: NO_ACE }, ps: { err: Object.assign(new Error("x"), { killed: true }) } });
    t("PowerShell 逾時:nogroup,log 寫 lookup failed (timeout)", (await acl.ensure()) === "nogroup" && logs.length === 1 && /group lookup failed \(timeout\)/.test(logs[0]));
  }
  {
    const { acl, logs } = fake({ check: { out: NO_ACE }, ps: { out: SID + "-garbage x" } });
    t("PowerShell 回的不是 SID:log 不帶輸出內容", (await acl.ensure()) === "nogroup" && logs.length === 1 && /unexpected output/.test(logs[0]) && !logs[0].includes(SID));
  }
  t("hasReadAce:DENY 的不算、R 只有讀不算、直接寫在檔案上的 (OI)(CI) 不算、組合形式 (RX,W) / (GR,GE) 算、F / M 算", !W.hasReadAce("X\\CodexSandboxUsers:(DENY)(RX)") && !W.hasReadAce("X\\CodexSandboxUsers:(I)(R)")
    && !W.hasReadAce("X\\CodexSandboxUsers:(OI)(CI)(RX)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(OI)(CI)(RX)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(RX,W)") && !W.hasReadAce("X\\CodexSandboxUsers:(DENY)(RX,W)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(GR,GE)") && !W.hasReadAce("X\\CodexSandboxUsers:(I)(GR)") && W.hasReadAce("X\\CodexSandboxUsers:(F)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(M)") && !W.hasReadAce("X\\OtherCodexSandboxUsersX:(RX)"));

  // 接線:ensureEngine 在引擎安裝之後補授權,回傳值照舊是 ensure 的
  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("main.js:ensureEngine = engineSetup().ensure() 之後叫 sandboxAcl() 但不等它,值原樣回去", /function ensureEngine\(\) \{ return engineSetup\(\)\.ensure\(\)\.then\(\(r\) => \{ try \{ sandboxAcl\(\); \} catch \(e\) \{[^}]*\} return r; \}\); \}/.test(src));
  t("main.js:帶 WIN / app.isPackaged / BUNDLED_PY 進去", /createSandboxAcl\(\{\s*win: WIN, packaged: app\.isPackaged, pyExe: BUNDLED_PY,/.test(src));
  t("main.js:帶 codexConfig;CODEX_HOME 優先、沒檔回空字串、其他錯誤丟出", /codexConfig: codexConfigText,/.test(src)
    && /process\.env\.CODEX_HOME \|\| path\.join\(os\.homedir\(\), "\.codex"\)/.test(src) && /if \(e && e\.code === "ENOENT"\) return ""; throw e;/.test(src));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
