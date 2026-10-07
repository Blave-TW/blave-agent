/* Windows + Codex 的 elevated 沙盒(用戶 ~/.codex/config.toml 設 [windows] sandbox = "elevated",Codex 桌面版會設):
   沙盒指令用另一個本機帳號跑,只讀得到授權給本機群組 CodexSandboxUsers 的路徑。Codex 自己會對 %USERPROFILE% 第一層每個資料夾
   加 (OI)(CI)(RX),但有用戶機上那條 ACE 沒一路繼承到 %LOCALAPPDATA%\Programs\Blave\resources\python-x64\(原因不明);
   venv 的 pyvenv.cfg home= 指向那裡 → 沙盒裡跑 venv 的 python.exe 時 launcher 報「No Python at …」,回測全死、聊天照常。
   修法:直接把隨包 Python 目錄授權給那個群組。per-user 安裝,目錄是用戶自己的,不用管理員。
   兩條都要:帶 (OI)(CI) 的 /T 不會把 ACE 寫進檔案本身(python.exe 會變成「Unable to create process」),第二條逐檔給 RX。
   一次啟動只做一次:ACL 只會被 NSIS 重裝(自動更新)換掉,而更新一定重開 app。代價:用戶在 app 開著時才改成 elevated,下次開 app 才生效。
   失敗只記 log、永遠 resolve——不能擋聊天。這個檔不 require electron;execFile 由呼叫端注入(tests/check_shell_win_sandbox_acl.js)。 */
"use strict";

const GROUP = "CodexSandboxUsers";   // Codex 建的固定英文名,中文版 Windows 也不在地化
const SID_RE = /^S-1-\d+(-\d+)+$/;
// icacls 印的是帳號名稱不是 SID:「<機器名>\CodexSandboxUsers:(I)(RX)」。DENY 的不算;讀+執行 = RX、M、F 其中一個,或 GR 加 GE。
// 直接寫在檔案上、帶 (OI)/(CI) 的(不是繼承來的 I)也不算:那正是上面說的 python.exe 起不來的狀態
function hasReadAce(icaclsOut) {
  const re = new RegExp("\\\\" + GROUP + ":((?:\\([A-Z,]+\\))+)", "g");
  for (const m of String(icaclsOut || "").matchAll(re)) {
    // 權限可能是組合形式:(I)(RX,W)、(I)(GR,GE)——拆逗號後逐項看
    const flags = m[1].slice(1, -1).split(/\)\(|,/);
    const badDirect = !flags.includes("I") && (flags.includes("OI") || flags.includes("CI"));
    const canRun = flags.some((f) => f === "RX" || f === "M" || f === "F") || (flags.includes("GR") && flags.includes("GE"));
    if (!flags.includes("DENY") && !badDirect && canRun) return true;
  }
  return false;
}
function grantArgv(dir, sid) {
  return [
    [dir, "/grant", `*${sid}:(OI)(CI)RX`, "/C", "/Q"],
    [dir + "\\*", "/grant", `*${sid}:RX`, "/T", "/C", "/Q"],
  ];
}

/* o = { win, packaged, pyExe, exists, execFile, systemRoot, log }。ensure() 永遠 resolve 成
   "skip"(不是打包版 Windows / 沒有隨包 Python)、"nogroup"、"ok"(本來就有)、"granted"、"fail" */
function createSandboxAcl(o) {
  let run = null;
  const sys32 = (o.systemRoot || "C:\\Windows") + "\\System32";
  // 絕對路徑:不讓 cwd / PATH 裡同名的 icacls.exe、powershell.exe 排到前面
  const ICACLS = sys32 + "\\icacls.exe", PS = sys32 + "\\WindowsPowerShell\\v1.0\\powershell.exe";
  const exec = (bin, args, timeout) => new Promise((resolve) => {
    o.execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || ""), why: err ? (err.killed ? "timeout" : "exit " + err.code) : "" });
    });
  });
  async function go() {
    if (!o.win || !o.packaged || !o.exists(o.pyExe)) return "skip";
    const dir = o.pyExe.slice(0, o.pyExe.lastIndexOf("\\"));
    const cur = await exec(ICACLS, [o.pyExe], 15000);
    if (cur.ok && hasReadAce(cur.out)) return "ok";
    // 群組不存在(沒用過 elevated Codex)= Translate 丟例外、非 0 結束
    const ps = await exec(PS, ["-NoProfile", "-NonInteractive", "-Command",
      `(New-Object System.Security.Principal.NTAccount('${GROUP}')).Translate([System.Security.Principal.SecurityIdentifier]).Value`], 20000);
    const sid = ps.out.trim();
    if (!ps.ok || !SID_RE.test(sid)) return "nogroup";
    const [a, b] = grantArgv(dir, sid);
    const r1 = await exec(ICACLS, a, 30000);
    const r2 = await exec(ICACLS, b, 180000);
    if (r1.ok && r2.ok) { o.log("[engine] codex sandbox: granted " + GROUP + " read on bundled python"); return "granted"; }
    o.log("[engine] codex sandbox: icacls grant failed (dir: " + (r1.why || "ok") + ", files: " + (r2.why || "ok") + ")");
    return "fail";
  }
  return {
    ensure() {
      if (!run) run = go().catch((e) => { o.log("[engine] codex sandbox acl check failed: " + ((e && e.message) || e)); return "fail"; });
      return run;
    },
  };
}

module.exports = { createSandboxAcl, grantArgv, hasReadAce, GROUP };
