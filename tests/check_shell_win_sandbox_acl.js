// shell/winsandbox.js:Codex elevated 沙盒讀不到隨包 Python 時,把 python-x64 目錄授權給 CodexSandboxUsers。
// 不跑真的 icacls / powershell:execFile 是替身,照呼叫的執行檔回事先排好的結果。跑法:node tests/check_shell_win_sandbox_acl.js
const fs = require("fs"), path = require("path");
const W = require("../shell/winsandbox");
let red = 0; const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };

const PY = "C:\\Users\\u\\AppData\\Local\\Programs\\Blave\\resources\\python-x64\\python.exe";
const DIR = "C:\\Users\\u\\AppData\\Local\\Programs\\Blave\\resources\\python-x64";
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1005";
const NO_ACE = PY + " NT AUTHORITY\\SYSTEM:(I)(F)\r\n    BUILTIN\\Administrators:(I)(F)\r\n    DESKTOP-1\\u:(I)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n";
const WITH_ACE = NO_ACE.replace("DESKTOP-1\\u:(I)(F)", "DESKTOP-1\\u:(I)(F)\r\n    DESKTOP-1\\CodexSandboxUsers:(I)(RX)");

// answers:{ check, ps, grant1, grant2 },各為 { err, out };沒給的那一步當它成功、沒輸出
function fake(answers, opts = {}) {
  const calls = [];
  const execFile = (bin, args, options, cb) => {
    calls.push({ bin, args, options });
    const step = /powershell\.exe$/.test(bin) ? "ps" : args.length === 1 ? "check" : args.includes("/T") ? "grant2" : "grant1";
    const a = answers[step] || {};
    setImmediate(() => cb(a.err || null, a.out || "", ""));
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
  t("hasReadAce:DENY 的不算、R 只有讀不算、直接寫在檔案上的 (OI)(CI) 不算、組合形式 (RX,W) / (GR,GE) 算、F / M 算", !W.hasReadAce("X\\CodexSandboxUsers:(DENY)(RX)") && !W.hasReadAce("X\\CodexSandboxUsers:(I)(R)")
    && !W.hasReadAce("X\\CodexSandboxUsers:(OI)(CI)(RX)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(OI)(CI)(RX)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(RX,W)") && !W.hasReadAce("X\\CodexSandboxUsers:(DENY)(RX,W)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(GR,GE)") && !W.hasReadAce("X\\CodexSandboxUsers:(I)(GR)") && W.hasReadAce("X\\CodexSandboxUsers:(F)") && W.hasReadAce("X\\CodexSandboxUsers:(I)(M)") && !W.hasReadAce("X\\OtherCodexSandboxUsersX:(RX)"));

  // 接線:ensureEngine 在引擎安裝之後補授權,回傳值照舊是 ensure 的
  const src = fs.readFileSync(path.join(__dirname, "..", "shell", "main.js"), "utf8");
  t("main.js:ensureEngine = engineSetup().ensure() 之後叫 sandboxAcl() 但不等它,值原樣回去", /function ensureEngine\(\) \{ return engineSetup\(\)\.ensure\(\)\.then\(\(r\) => \{ try \{ sandboxAcl\(\); \} catch \(e\) \{[^}]*\} return r; \}\); \}/.test(src));
  t("main.js:帶 WIN / app.isPackaged / BUNDLED_PY 進去", /createSandboxAcl\(\{\s*win: WIN, packaged: app\.isPackaged, pyExe: BUNDLED_PY,/.test(src));
  console.log(red ? red + " 紅" : "ALL PASS"); process.exit(red ? 1 : 0);
})();
