// shell/devicetype.js:筆電／桌機偵測(埋點 device_type)。指令輸出全部 stub,不跑真的 pmset / PowerShell。
// 跑法:node tests/check_shell_devicetype.js
const path = require("path");
const D = require("../shell/devicetype.js");
let red = 0, finished = false;
process.on("exit", () => { if (!finished) { console.log("FAIL  沒跑完就結束了"); process.exitCode = 1; } });
const t = (n, ok) => { console.log((ok ? "PASS  " : "FAIL  ") + n); if (!ok) red++; };

const calls = [];
const runOk = (stdout) => (file, args) => { calls.push([file, args]); return Promise.resolve({ ok: true, stdout }); };
const runFail = (file, args) => { calls.push([file, args]); return Promise.resolve({ ok: false, stdout: "" }); };
const win = (chassis, battery) => chassis.map((n) => "C " + n).concat(battery === undefined ? [] : ["B " + battery]).join("\r\n") + "\r\n";
const det = (platform, run, extra = {}) => D.detectDeviceType({ platform, run, systemRoot: "C:\\Windows", ...extra });

(async () => {
  // ── 四組合起來剛好 1–36、互不重疊:有人改其中一組時擋下來 ──
  const all = [...D.LAPTOP, ...D.DESKTOP, ...D.SERVER, ...D.NEUTRAL];
  t("筆電／桌機／伺服器／中性四組合起來剛好是 1–36、彼此不重疊",
    all.length === 36 && new Set(all).size === 36 && Array.from({ length: 36 }, (_, i) => i + 1).every((n) => all.includes(n)));
  t("逐值分類:筆電值→laptop、桌機值→desktop、伺服器值→unknown、中性值→null(交給電池)",
    D.LAPTOP.every((n) => D.classifyChassis([n]) === "laptop") && D.DESKTOP.every((n) => D.classifyChassis([n]) === "desktop")
    && D.SERVER.every((n) => D.classifyChassis([n]) === "unknown") && D.NEUTRAL.every((n) => D.classifyChassis([n]) === null)
    && D.classifyChassis([0]) === null && D.classifyChassis([37]) === null && D.classifyChassis([]) === null);

  // ── macOS ──
  calls.length = 0;
  t("Mac 有電池(InternalBattery)→ laptop", await det("darwin", runOk("Now drawing from 'AC Power'\n -InternalBattery-0 (id=7077987)\t100%; charged; 0:00 remaining present: true\n")) === "laptop");
  t("…指令是 /usr/bin/pmset -g batt(絕對路徑、固定參數)", JSON.stringify(calls[0]) === JSON.stringify(["/usr/bin/pmset", ["-g", "batt"]]));
  t("Mac 沒電池(只有 AC Power 一行)→ desktop", await det("darwin", runOk("Now drawing from 'AC Power'\n")) === "desktop");
  t("Mac 桌機接 UPS(UPS 那一行不含 InternalBattery)→ desktop", await det("darwin", runOk("Now drawing from 'UPS Power'\n -Back-UPS ES 550 (id=123)\t90%; discharging\n")) === "desktop");
  t("Mac 指令失敗 → unknown", await det("darwin", runFail) === "unknown");

  // ── Windows ──
  calls.length = 0;
  t("Windows ChassisTypes=10 → laptop", await det("win32", runOk(win([10], 1))) === "laptop");
  const [file, args] = calls[0];
  t("…PowerShell 用 SystemRoot 底下的絕對路徑,-NoProfile -NonInteractive -Command,讀 Win32_SystemEnclosure 與 Win32_Battery、不用 wmic",
    file === path.win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    && JSON.stringify(args.slice(0, 3)) === '["-NoProfile","-NonInteractive","-Command"]' && args.length === 4
    && /Win32_SystemEnclosure/.test(args[3]) && /Win32_Battery/.test(args[3]) && !/wmic/i.test(args[3]));
  t("Windows ChassisTypes=3 → desktop", await det("win32", runOk(win([3], 0))) === "desktop");
  t("Windows ChassisTypes=1 且沒有電池 → unknown", await det("win32", runOk(win([1], 0))) === "unknown");
  t("Windows ChassisTypes=1 但有電池 → laptop(電池備援)", await det("win32", runOk(win([1], 1))) === "laptop");
  t("Windows 指令失敗 → unknown", await det("win32", runFail) === "unknown");
  t("Windows ChassisTypes=[3,12] → desktop(擴充座不翻成筆電)", await det("win32", runOk(win([3, 12], 0))) === "desktop");
  t("Windows ChassisTypes=[0x8A] → laptop(第 7 位元是機殼鎖)", await det("win32", runOk(win([0x8a], 0))) === "laptop");
  t("Windows ChassisTypes=[23] → unknown(伺服器,有電池也不看)", await det("win32", runOk(win([23], 1))) === "unknown");
  t("Windows 多個機殼執行個體:[12] + [10] → laptop", await det("win32", runOk(win([12, 10], 0))) === "laptop");
  t("Windows ChassisTypes 空值、沒有電池 → unknown;有電池 → laptop", await det("win32", runOk(win([], 0))) === "unknown" && await det("win32", runOk(win([], 2))) === "laptop");
  t("Windows 輸出沒跑完(沒有電池那一行)→ unknown", await det("win32", runOk(win([3]))) === "unknown");

  // ── Linux(最小實作)──
  const sysfs = (files) => ({
    readdir: (d) => (d === "/sys/class/power_supply" && files.ps ? Promise.resolve(Object.keys(files.ps)) : Promise.reject(new Error("ENOENT"))),
    readFile: (f) => {
      const m = /^\/sys\/class\/power_supply\/([^/]+)\/(type|scope)$/.exec(f);
      const v = m ? ((files.ps || {})[m[1]] || {})[m[2]] : f === "/sys/class/dmi/id/chassis_type" ? files.chassis : undefined;
      return v === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(v + "\n");
    },
  });
  t("Linux 有系統電池(type=Battery、沒有 scope)→ laptop", await det("linux", runFail, sysfs({ ps: { AC: { type: "Mains" }, BAT0: { type: "Battery" } }, chassis: "3" })) === "laptop");
  t("Linux 只有藍牙滑鼠的電池(scope=Device)→ 看 chassis_type:3 → desktop", await det("linux", runFail, sysfs({ ps: { hid_mouse: { type: "Battery", scope: "Device" } }, chassis: "3" })) === "desktop");
  t("Linux 沒電池、chassis_type 中性 → unknown;讀不到 → unknown", await det("linux", runFail, sysfs({ chassis: "1" })) === "unknown" && await det("linux", runFail, sysfs({})) === "unknown");

  // ── 不炸、不卡 ──
  t("run 丟例外 → unknown(不 reject)", await det("darwin", () => { throw new Error("boom"); }) === "unknown");
  t("run reject → unknown", await det("win32", () => Promise.reject(new Error("boom"))) === "unknown");
  // 模組的逾時計時器是 unref 的(不拖住 app 結束);這裡另掛一顆有 ref 的,否則 node 會在等待中安靜地以 0 結束
  const t0 = Date.now(), hold = setTimeout(() => {}, 5000);
  t("逾時 → unknown(不等卡住的指令)", await det("darwin", () => new Promise(() => {}), { timeoutMs: 50 }) === "unknown" && Date.now() - t0 < 1000);
  clearTimeout(hold);
  t("不認得的平台 → unknown、不跑任何指令", (calls.length = 0, await det("freebsd", runOk("x")) === "unknown") && calls.length === 0);
  t("逾時是 10 秒", D.TIMEOUT_MS === 10000);

  finished = true;
  console.log(red ? `\n${red} 條紅` : "\n全綠");
  process.exit(red ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
