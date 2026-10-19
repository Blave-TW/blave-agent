// 這台電腦是筆電還是桌機(埋點 device_type;spec desktop-telemetry-device-chassis-2026-10-19)。
// 主行程每次啟動跑一次、結果放記憶體。永遠 resolve 成 laptop / desktop / unknown 其中一個,不 reject、不擋啟動:
// 任何錯誤或超過 TIMEOUT_MS 都是 unknown。外部指令只用 execFile + 絕對路徑 + 固定參數,不經 shell、不靠 PATH。
// 不載 electron:測試與真機單跑(node -e)都要能直接 require。
const path = require("path");

const TIMEOUT_MS = 10 * 1000;

// SMBIOS DSP0134 3.9.0 §7.4.1 Table 17(1–36)。以 MDT 8456 ZTIGather.wsf 的 IsLaptop／IsDesktop 為底,
// 12、18、21 改中性(擴充座／擴充箱不代表電腦本體;MDT 本身就跳過 12、21),桌機多收 24,伺服器與非個人電腦回 unknown。
// 四組合起來剛好 1–36、互不重疊(tests/check_shell_devicetype.js 列舉釘住);表外的值當中性
const LAPTOP = [8, 9, 10, 11, 14, 30, 31, 32];
const DESKTOP = [3, 4, 5, 6, 7, 13, 15, 16, 24, 35, 36];
const SERVER = [17, 22, 23, 25, 26, 27, 28, 29, 33, 34];
const NEUTRAL = [1, 2, 12, 18, 19, 20, 21];

// 回 laptop / desktop / unknown;全部都是中性值(或沒有值)回 null = 交給電池判。
// 筆電值優先:筆電接底座偶爾同時報桌機類值,反過來沒有合理成因。第 7 位元是機殼鎖旗標,不是型別
function classifyChassis(values) {
  const v = values.map((n) => n & 0x7f);
  if (v.some((n) => LAPTOP.includes(n))) return "laptop";
  if (v.some((n) => DESKTOP.includes(n))) return "desktop";
  if (v.some((n) => SERVER.includes(n))) return "unknown";
  return null;
}

// Win32_SystemEnclosure 可能有多個執行個體、ChassisTypes 本身是陣列也可能是空值:全部攤平成一行一個數字。
// 電池只數個數;放同一次呼叫,省掉第二次 PowerShell 冷啟動
const WIN_PS = "$ErrorActionPreference='Stop';"
  + "Get-CimInstance -ClassName Win32_SystemEnclosure | ForEach-Object { $_.ChassisTypes } | ForEach-Object { 'C ' + [int]$_ };"
  + "'B ' + @(Get-CimInstance -ClassName Win32_Battery).Count";

function parseWin(stdout) {
  const chassis = [];
  let battery = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^([CB]) (\d{1,5})$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "C") chassis.push(Number(m[2]));
    else battery = Number(m[2]);
  }
  if (battery === null) return "unknown";   // 沒跑完(B 那行是最後印的)
  // 電池只當備援:USB 接的 UPS 也可能被當成電池
  return classifyChassis(chassis) || (battery > 0 ? "laptop" : "unknown");
}

/* deps(測試換掉):platform, run(file, args) → Promise<{ ok, stdout }>, readdir(dir) → Promise<string[]>,
   readFile(file) → Promise<string>, systemRoot, timeoutMs */
function detectDeviceType(deps = {}) {
  const platform = deps.platform || process.platform;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const run = deps.run || ((file, args) => new Promise((resolve) => {
    require("child_process").execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout || "") }));
  }));
  const fsp = require("fs").promises;
  const readdir = deps.readdir || ((d) => fsp.readdir(d));
  const readFile = deps.readFile || ((f) => fsp.readFile(f, "utf8"));

  async function mac() {
    const r = await run("/usr/bin/pmset", ["-g", "batt"]);
    if (!r.ok) return "unknown";
    // 接 UPS 的桌機 Mac 會多一行 UPS 的產品名,不含 InternalBattery
    return /InternalBattery/.test(r.stdout) ? "laptop" : "desktop";
  }
  async function win() {
    const ps = path.win32.join(deps.systemRoot || process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const r = await run(ps, ["-NoProfile", "-NonInteractive", "-Command", WIN_PS]);
    return r.ok ? parseWin(r.stdout) : "unknown";
  }
  async function linux() {
    const base = "/sys/class/power_supply";
    let names = [];
    try { names = await readdir(base); } catch (_) { /* 沒有這個目錄 = 沒有電源資訊 */ }
    for (const n of names) {
      const read = (f) => readFile(path.posix.join(base, n, f)).then((s) => s.trim(), () => null);
      // scope=Device 是藍牙／USB 滑鼠鍵盤這類周邊的電池;ACPI 系統電池通常沒有 scope 檔
      if ((await read("type")) === "Battery" && (await read("scope")) !== "Device") return "laptop";
    }
    try {
      const n = Number((await readFile("/sys/class/dmi/id/chassis_type")).trim());
      return Number.isInteger(n) ? classifyChassis([n]) || "unknown" : "unknown";
    } catch (_) { return "unknown"; }
  }

  const job = { darwin: mac, win32: win, linux }[platform];
  if (!job) return Promise.resolve("unknown");
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve("unknown"), timeoutMs); if (timer.unref) timer.unref(); });
  const work = Promise.resolve().then(job).catch(() => "unknown");
  return Promise.race([work, late]).then((k) => { clearTimeout(timer); return k; });
}

module.exports = { detectDeviceType, classifyChassis, parseWin, LAPTOP, DESKTOP, SERVER, NEUTRAL, TIMEOUT_MS };
