// stats_refresh 的形狀:renderer 送的 → daemon.js 放行的 → 同一棵樹打包進去的 runtime(command_listener._stats_refresh_args)收的,三層要同一份。
// 為什麼有這支(稽核 v034-xt-ondemand P1-1):電腦版分支曾經只改了 renderer 與 daemon.js,打包的 runtime 還是只收 {names},
// 本機每按一次〔開始測試〕都是 BAD_ARGS。這支用 python3 從這棵樹的 runtime/command_listener.py 用 ast 切出那支函式與它的常數直接跑
// (不 import 整支 listener),同一組形狀餵給 daemon.js 的 argsOk,兩邊答案要一樣,而且成交測試那顆送的形狀兩邊都收。
// 名字是 check_shell_*:shell/tools/release.js 發版前一定跑到。
// 跑法:node tests/check_shell_stats_refresh_contract.js
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, ".."), LISTENER = path.join(ROOT, "runtime", "command_listener.py");
let red = 0; const ok = (n, c, why) => { console.log((c ? "PASS  " : "FAIL  ") + n + (c || why === undefined ? "" : "\n      " + JSON.stringify(why))); if (!c) red++; };

const { argsOk } = require(path.join(ROOT, "shell", "daemon.js"));
const CASES = [
  { names: ["momo"] }, { names: ["momo", "b-2"] }, { names: ["momo"], exec_test: true },
  { names: ["momo", "b-2"], exec_test: true }, { names: ["momo"], exec_test: false }, { names: ["momo"], exec_test: "true" },
  { names: ["momo"], exec_test: 1 }, { names: ["momo"], exec_test: null }, { exec_test: true }, { names: ["momo"], exec_test: true, x: 1 },
  { names: ["momo"], x: 1 }, { names: [] }, { names: ["momo", "momo"] }, { names: ["a.b"] }, { names: Array.from({ length: 51 }, (_, i) => "s" + i) },
];
const PY = `
import ast, json, re, sys
src = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(src)
want = {"STATS_REFRESH_MAX_NAMES", "_VERSION_RESTORE_NAME_RE", "_STATS_REFRESH_NAME_RE", "_stats_refresh_args"}
keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in want)
        or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in want for t in n.targets))]
ns = {"re": re}
exec(compile(ast.Module(body=keep, type_ignores=[]), "command_listener.py", "exec"), ns)
out = []
for a in json.load(sys.stdin):
    try:
        r = ns["_stats_refresh_args"](a)
        out.append(True if r is not None else False)
    except ValueError:
        out.append(False)
print(json.dumps(out))
`;
let got = null, err = null;
try { got = JSON.parse(execFileSync("python3", ["-I", "-c", PY, LISTENER], { input: JSON.stringify(CASES), encoding: "utf8" })); } catch (e) { err = String(e.stderr || e.message).slice(-400); }
ok("這棵樹的 runtime/command_listener.py 切得出 _stats_refresh_args 並跑得起來", Array.isArray(got) && got.length === CASES.length, err);
if (Array.isArray(got)) {
  const daemon = CASES.map((a) => argsOk("stats_refresh", a) === true);
  const diff = CASES.filter((_, i) => daemon[i] !== got[i]).map((a, i) => JSON.stringify(a));
  ok("daemon.js 與打包的 runtime 對 " + CASES.length + " 種形狀答案一樣", diff.length === 0, diff);
  ok("成交測試那顆送的 {names:[一支], exec_test:true}:daemon.js 與 runtime 都收(收不下 = 本機每按一次都 BAD_ARGS)", got[2] === true && daemon[2] === true, { runtime: got[2], daemon: daemon[2] });
  ok("回測數據那顆送的 {names:[一支]} 照舊兩邊都收", got[0] === true && daemon[0] === true);
}
const perf = fs.readFileSync(path.join(ROOT, "shell", "renderer", "perf.js"), "utf8");
ok("renderer 送的就是這兩種形狀(names 一支,成交測試那顆另帶 exec_test = true)", /const args = \{ names: \[name\] \};/.test(perf) && /args\.exec_test = true;/.test(perf));
console.log(red ? `\n${red} 紅` : "\nALL PASS"); process.exit(red ? 1 : 0);
