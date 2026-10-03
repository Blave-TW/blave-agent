#!/usr/bin/env node
// 重解 main.js 的 WORKSPACE_LOCK(間接相依的版本,稽核 2026-10-02 P2-4)。SDK_PINS 或 WORKSPACE_DEPS 換了就跑,把印出來的兩段貼回 main.js。
//   node tools/lock-deps.js <venv 的 python>
// venv 要用隨包 Python 建(pip 版本跟用戶機一樣):vendor/python-arm64/bin/python3 -m venv <dir>。只做 dry-run,不裝任何東西。
// 每個平台各解一次,版本全部一樣才印;--platform 只換 wheel、環境標記照跑這台機器的值,所以 Windows 才有的相依
// (sys_platform == "win32" / platform_system == "Windows")從 Windows 那份 report 的 requires_dist 找出來另外補。
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const { lockKey } = require("../enginesetup");

const py = process.argv[2];
if (!py) { console.error("用法:node tools/lock-deps.js <venv 的 python>"); process.exit(1); }
const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const lit = (re) => { const m = re.exec(src); if (!m) throw new Error("main.js 裡找不到 " + re); return m[1]; };
const DEPS = vm.runInNewContext(lit(/const WORKSPACE_DEPS = (\[[\s\S]*?\]);/));
const SDK = vm.runInNewContext("`" + lit(/const SDK_PINS = `([^`]+)`;/) + "`", { AGENT_SDK: vm.runInNewContext(lit(/const AGENT_SDK = ("[^"]+");/)) });
// 用戶機的範圍:macOS 12 起(pyarrow 25 沒有 11 的 wheel)兩種架構、14 起的新 wheel、Windows x64
const PLATFORMS = ["macosx_14_0_arm64", "macosx_12_0_arm64", "macosx_14_0_x86_64", "macosx_12_0_x86_64", "win_amd64"];
const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blave-lock-"));
const pins = path.join(tmp, "pins.txt");
fs.writeFileSync(pins, DEPS.join("\n") + "\n");
const pip = (args) => { const r = spawnSync(py, ["-m", "pip", "--isolated", "--disable-pip-version-check", ...args], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stdout + r.stderr); process.exit(1); } return r; };

const seen = {};
let win = null;
for (const p of PLATFORMS) {
  const rep = path.join(tmp, p + ".json");
  pip(["install", "-q", "--dry-run", "--ignore-installed", "--only-binary=:all:", "--platform", p, "--python-version", "3.12", "--implementation", "cp",
    "--target", path.join(tmp, "t-" + p), "--report", rep, "-c", pins, ...SDK.split(" "), ...DEPS]);
  const r = JSON.parse(fs.readFileSync(rep, "utf8"));
  seen[p] = Object.fromEntries(r.install.map((i) => [norm(i.metadata.name), i.metadata.version]));
  if (p === "win_amd64") win = r;
}
const names = [...new Set(Object.values(seen).flatMap(Object.keys))].sort();
const split = names.filter((n) => new Set(PLATFORMS.map((p) => seen[p][n])).size > 1);
if (split.length) { console.error("平台之間解出來的版本不一樣(不能用同一份鎖):\n" + split.map((n) => `  ${n}: ` + PLATFORMS.map((p) => `${p}=${seen[p][n] || "-"}`).join(" ")).join("\n")); process.exit(1); }
const lock = Object.fromEntries(names.map((n) => [n, seen[PLATFORMS[0]][n]]));
const WIN_ONLY = /(sys_platform\s*==\s*["']win32["']|platform_system\s*==\s*["']Windows["'])/;
for (const i of win.install) for (const d of i.metadata.requires_dist || []) {
  if (!WIN_ONLY.test(d) || /extra\s*==/.test(d)) continue;
  const spec = d.split(";")[0].trim(), n = norm(spec.split(/[<>=!~ \[(]/)[0]);
  if (lock[n]) continue;
  const dir = path.join(tmp, "win-" + n);
  pip(["download", "-q", "--no-deps", "--only-binary=:all:", "--platform", "win_amd64", "--python-version", "3.12", "--implementation", "cp", "-d", dir, spec]);
  const whl = fs.readdirSync(dir).find((f) => f.endsWith(".whl"));
  lock[n] = whl.split("-")[1];
}
const direct = new Set([...DEPS, ...SDK.split(" ")].map((p) => norm(p.split("==")[0])));
const out = Object.keys(lock).filter((n) => !direct.has(n)).sort().map((n) => `${n}==${lock[n]}`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`const WORKSPACE_LOCK_FOR = "${lockKey(SDK, DEPS)}";`);
console.log("const WORKSPACE_LOCK = [\n" + out.map((l, i) => (i % 6 === 0 ? "  " : " ") + JSON.stringify(l) + "," + (i % 6 === 5 || i === out.length - 1 ? "\n" : "")).join("") + "];");
