// tests/ 下會啟動 Electron 的測試,每一支都要走 tests/_electron_gate.js(預設不起 Electron,BLAVE_TEST_WINDOW=1 才起)。
// 清單是掃出來的,不是寫死的:新測試自己組 Electron 路徑、或沒接守門,這支就紅。
// 跑法:node tests/check_tests_window_guard.js(不起 Electron)
const fs = require("fs"), path = require("path"), cp = require("child_process");
const DIR = __dirname, GATE_FILE = "_electron_gate.js", SELF = path.basename(__filename);
let red = 0; const t = (n, ok, why) => { console.log((ok ? "PASS  " : "FAIL  ") + n + (ok || !why ? "" : "\n      " + why)); if (!ok) red++; };

// 「會啟動 Electron」的記號:自己組執行檔路徑、在 Electron 裡跑的那一段、或用別的方式叫起來
const LAUNCH = /\.bin["'],\s*["']electron|\.bin[\\/]+electron|require\(\s*["']electron["']\s*\)|process\.versions\.electron|require\.resolve\(\s*["']electron|electron[\\/]cli|npx\s+electron|Electron\.app/;
const OWN_PATH = /\.bin["'],\s*["']electron|\.bin[\\/]+electron|require\.resolve\(\s*["']electron|electron[\\/]cli|npx\s+electron|Electron\.app|existsSync\(bin\)/;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === "__pycache__" || e.name === "node_modules" ? []
  : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const all = walk(DIR).filter((f) => /\.(c?js|mjs|py|sh)$/.test(f)).map((f) => path.relative(DIR, f)).filter((f) => f !== GATE_FILE && f !== SELF).sort();
const hits = all.filter((f) => LAUNCH.test(fs.readFileSync(path.join(DIR, f), "utf8")));

console.log(`會啟動 Electron 的測試:${hits.length} 支`);
for (const f of hits) {
  const s = fs.readFileSync(path.join(DIR, f), "utf8"), bad = [];
  if (!/\.js$/.test(f)) bad.push("不是 .js:守門只有 node 版,Electron 測試請寫成 .js");
  const req = s.search(/^const GATE = require\("\.\/_electron_gate"\);$/m);
  const first = s.search(/process\.versions\.electron|require\(\s*["']electron["']\s*\)/);
  if (req < 0) bad.push('最上層沒有 const GATE = require("./_electron_gate");');
  else if (first >= 0 && req > first) bad.push("守門的 require 要在 process.versions.electron / require(\"electron\") 之前");
  if (!/\bGATE\.bin\(SHELL\b/.test(s)) bad.push("Electron 的路徑沒有走 GATE.bin(SHELL)");
  if (OWN_PATH.test(s)) bad.push("自己組 Electron 的路徑(繞過守門)");
  for (const m of s.matchAll(/new BrowserWindow\(([^\n]{0,200})/g)) if (!/show: false/.test(m[1])) bad.push("BrowserWindow 沒有 show: false(要顯示請之後呼叫 showInactive())");
  if (/\bapp\.focus\(|\.moveTop\(\)|app\.dock\.show\(/.test(s)) bad.push("搶前景的呼叫(app.focus / moveTop / dock.show)");
  t(f, !bad.length, bad.join(";"));
}

// 守門本身:只有 BLAVE_TEST_WINDOW=1 放行;沒設時印那一行 SKIP、回 null
{ const G = require("./" + GATE_FILE), src = fs.readFileSync(path.join(DIR, GATE_FILE), "utf8");
  const SHELL = path.join(DIR, "..", "shell");
  const probe = (v) => { const env = { ...process.env }; delete env[G.ENV]; if (v !== undefined) env[G.ENV] = v;
    const r = cp.spawnSync(process.execPath, ["-e", `const b = require(${JSON.stringify(path.join(DIR, GATE_FILE))}).bin(${JSON.stringify(SHELL)}, "②"); console.log("BIN=" + b)`], { env, encoding: "utf8" });
    return r.stdout || ""; };
  const off = [undefined, "", "0", "true", "yes"].map(probe);
  // 這支自己的輸出不能帶守門那行字(release.js 看到它就當作有一段沒跑到)
  t("沒設 / 設成 1 以外的值:回 null、印守門那一行 SKIP(帶段落記號)", off.every((o) => /BIN=null/.test(o) && o.includes(G.SKIP_LINE + "  ②")), JSON.stringify(off).split(G.ENV).join("<ENV>"));
  const on = probe("1");
  t("設 1:回 shell/node_modules/.bin/electron(沒裝就印找不到、回 null),不印守門那一行", !on.includes(G.SKIP_LINE)
    && (fs.existsSync(path.join(SHELL, "node_modules", ".bin", "electron")) ? /BIN=.*node_modules[\\/]\.bin[\\/]electron\s*$/.test(on) : /BIN=null/.test(on)), on);
  t("SKIP 那一行的字面", G.SKIP_LINE === "SKIP (set BLAVE_TEST_WINDOW=1 to run the Electron part)");
  t("在 Electron 裡:沒開關就結束、不進 Dock、show 改 showInactive、focus 不動作",
    /if \(process\.versions\.electron\) \{\s*\n[^\n]*\n\s*if \(!allowed\(\)\) \{ console\.log\(SKIP_LINE\); process\.exit\(0\); \}/.test(src)
    && /app\.dock\.hide\(\)/.test(src) && /win\.show = \(\) => win\.showInactive\(\);/.test(src) && /win\.focus = \(\) => \{\};/.test(src)); }

t("掃得到東西(清單是空的 = 掃描壞了)", hits.length >= 24, "只掃到 " + hits.length);

// Windows workflow 的閘門測試(稽核 2026-10-02 P2-5／B1):跟 release.js 跑同一份清單、Electron 段落真的跑、印出守門那行 SKIP 就紅。
// 把 workflow 那段 bash 切出來,用假的 node / python 在暫存目錄裡真的跑
{ const ROOT = path.join(DIR, ".."), yaml = require(path.join(ROOT, "shell", "node_modules", "js-yaml"));
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, ".github", "workflows", "desktop-win.yml"), "utf8"));
  const step = ((wf.jobs.test || {}).steps || []).find((x) => x.name === "Gate tests") || {};
  t("CI 閘門:step 的 env 帶 BLAVE_TEST_WINDOW=1", !!step.env && step.env[require("./" + GATE_FILE).ENV] === "1", JSON.stringify(step.env));
  { const steps = (wf.jobs.test || {}).steps || [], si = steps.findIndex((x) => /defaults write -g AppleShowScrollBars -string WhenScrolling/.test(x.run || "")), gi = steps.indexOf(step);
    t("CI 閘門:Gate tests 之前把捲軸設成浮動式(跟發版機一樣;runner 沒觸控板會變常駐 15px 捲軸,版面測試誤紅)", si >= 0 && gi > si, JSON.stringify({ si, gi })); }
  const relSrc = fs.readFileSync(path.join(ROOT, "shell", "tools", "release.js"), "utf8");
  const relRe = /filter\(\(f\) => (\/\^\(check_shell_[^\n]*?\$\/)\.test\(f\) && f !== "check_shell_paths\.js"\)/.exec(relSrc);
  const want = relRe ? fs.readdirSync(DIR).filter((f) => eval(relRe[1]).test(f) && f !== "check_shell_paths.js").sort() : null;
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "blave-wingate-")), bin = path.join(tmp, "bin"), tdir = path.join(tmp, "tests");
  fs.mkdirSync(bin); fs.mkdirSync(tdir);
  for (const f of fs.readdirSync(DIR)) if (/\.(js|py)$/.test(f)) fs.writeFileSync(path.join(tdir, f), "");
  // 假 node:記下跑了哪支;FAKE_SKIP / FAKE_FAIL 點名的那支印守門那行 / exit 1
  fs.writeFileSync(path.join(bin, "node"), '#!/bin/bash\nb=$(basename "$1"); echo "$b" >> "$RAN"\n[ "$b" = "$FAKE_SKIP" ] && echo "' + require("./" + GATE_FILE).SKIP_LINE + '  ②"\n[ "$b" = "$FAKE_SKIP" ] && [ -n "$FAKE_BIG" ] && head -c 400000 /dev/zero | tr "\\\\0" x && echo\n[ "$b" = "$FAKE_FAIL" ] && exit 1\necho "PASS  x"; exit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "py"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const run = (o = {}) => { const ran = path.join(tmp, "ran-" + Math.random().toString(36).slice(2)); fs.writeFileSync(ran, "");
    const r = cp.spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run || "exit 99"], { cwd: tmp, encoding: "utf8",
      env: { PATH: bin + ":/usr/bin:/bin", RAN: ran, BLAVE_TEST_PYTHON: path.join(bin, "py"), FAKE_SKIP: o.skip || "", FAKE_FAIL: o.fail || "", FAKE_BIG: o.big ? "1" : "" } });
    return { status: r.status, out: r.stdout + r.stderr, ran: fs.readFileSync(ran, "utf8").split("\n").filter(Boolean).sort() }; };
  const ok = run();
  t("CI 閘門:跑的 node 測試 = release.js 閘門那一份(含 check_tests_window_guard.js)", !!want && want.length >= 10 && JSON.stringify(ok.ran) === JSON.stringify(want) && ok.ran.includes(SELF),
    JSON.stringify({ onlyCI: ok.ran.filter((x) => !(want || []).includes(x)), onlyRelease: (want || []).filter((x) => !ok.ran.includes(x)) }));
  t("CI 閘門:全部過 → exit 0", ok.status === 0, ok.out.slice(-300));
  const sk = run({ skip: "check_shell_esc.js" });
  t("CI 閘門:有一支印出守門那行 SKIP(exit 0)→ 整步紅,而且點名是哪支", sk.status !== 0 && /::error::tests\/check_shell_esc\.js/.test(sk.out), sk.out.slice(-300));
  const big = run({ skip: "check_shell_esc.js", big: true });
  t("CI 閘門:SKIP 那行後面還有 400KB 輸出(超過 pipe buffer;grep -q 早退、pipefail 下 printf | grep 會回 141 漏抓)→ 照樣紅", big.status !== 0 && /::error::tests\/check_shell_esc\.js 的 Electron/.test(big.out), big.out.slice(-300));
  const fl = run({ fail: "check_shell_esc.js" });
  t("CI 閘門:有一支 exit 1 → 整步紅,後面的照跑", fl.status !== 0 && /::error::tests\/check_shell_esc\.js 沒過/.test(fl.out) && fl.ran.length === ok.ran.length, fl.out.slice(-300));
  fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
