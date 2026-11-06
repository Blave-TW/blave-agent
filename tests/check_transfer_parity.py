"""The strategy-transfer name gates and caps are one rule on three sides: runtime/strategy_transfer.py
(the trust boundary), shell/transfer.js (what the app reads and sends) and the renderer's HO_ID_RE
(which strategies get a 送上雲端／拉回 button). Same corpus through all three; the caps and the stage
folder compared as values. A name one side lets through and another refuses is a button that fails,
or a file the app sends that the machine throws away.
Run: cd blave-agent && .venv/bin/python tests/check_transfer_parity.py
"""
import json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import strategy_transfer as T  # noqa: E402

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

NAMES = ["momo", "A-1_b", "x" * 64, "x" * 65, "", " ", "a b", "動能", "../x", "a/b", "a.b", "a\nb",
         "con", "CON", "Con", "con_2", "console", "nul", "NUL2", "aux", "prn", "com0", "COM9", "com10", "lpt1", "lpt", "LPT9x"]
FILES = ["strategy.py", "helper.py", "a.b.py", "_x.py", "-x.py", ".hidden.py", "x.PY", "x.pyc", "con.py", "CON.py",
         "con.helper.py", "console.py", "com1.py", "com10.py", "lpt9.py", "a b.py", "x" * 61 + ".py", "x" * 62 + ".py", "py"]
node = shutil.which("node")
if not node:
    print("SKIP no node on PATH")
    sys.exit(0)
js = r"""
const T = require(process.argv[1] + "/shell/transfer.js"), fs = require("fs");
const src = fs.readFileSync(process.argv[1] + "/shell/renderer/handoff.js", "utf8");
const HO = eval(/const HO_ID_RE = (\/.*?\/);/.exec(src)[1]);
const q = JSON.parse(process.argv[2]);
console.log(JSON.stringify({ name: q.names.map((n) => T.NAME_RE.test(n)), ho: q.names.map((n) => HO.test(n)),
  file: q.files.map((f) => T.FILE_RE.test(f)), caps: [T.MAX_FILES, T.FILE_MAX, T.TOTAL_MAX], stage: T.STAGE_DIR }));
"""
out = json.loads(subprocess.run([node, "-e", js, ROOT, json.dumps({"names": NAMES, "files": FILES})],
                                capture_output=True, text=True, check=True).stdout)
py_name = [bool(T.NAME_RE.fullmatch(n)) for n in NAMES]
py_file = [bool(T.FILE_RE.fullmatch(f)) for f in FILES]
check(out["name"] == py_name, "shell/transfer.js NAME_RE judges every name like the runtime "
      f"({[n for n, a, b in zip(NAMES, out['name'], py_name) if a != b]})")
check(out["ho"] == py_name, "renderer HO_ID_RE judges every name like the runtime "
      f"({[n for n, a, b in zip(NAMES, out['ho'], py_name) if a != b]})")
check(out["file"] == py_file, "shell/transfer.js FILE_RE judges every file name like the runtime "
      f"({[f for f, a, b in zip(FILES, out['file'], py_file) if a != b]})")
check(sum(py_name) >= 5 and not all(py_name) and sum(py_file) >= 4 and not all(py_file), "the corpus has both sides of each gate")
check(out["caps"] == [T.MAX_FILES, T.FILE_MAX, T.TOTAL_MAX], f"caps match: {out['caps']}")
check(out["stage"].replace("\\", "/") == T.STAGE_DIR.replace(os.sep, "/"), f"stage folder matches: {out['stage']}")
print(f"\n{'all passed' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
