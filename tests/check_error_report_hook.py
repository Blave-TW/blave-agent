"""Desktop error capture (lib/error_report.py, spec agent-error-report-2026-11-16 §3, §10).

Run: python tests/check_error_report_hook.py

The frame rule is exercised with real tracebacks through files laid out like a workspace in a temp
dir (lib/ = ours, strategies/ = the user's), so the paths the hook sees are the real thing:
  1. a user compute_fn raising inside a lib runner → no record (innermost non-library frame is the user's)
     (lib.runner.run itself is modelled by a fake runner; lib/allocator.load runs for real, §2a)
  2. lib catching the user's exception and re-raising `{e}` wrapped (lib/strategy.py's pattern) → recorded,
     but no user file, function or source line, and nothing from __cause__
  3. ast.parse of user code raising SyntaxError inside lib → recorded, without the source line
  4. lib calling into a stdlib / package function that raises (json.loads) → recorded
  5. §3.2's expected classes, a requests timeout and KeyboardInterrupt → no record; HTTPError → recorded
     publish()'s ReportRefused → no record; a record carries BLAVE_CHAT_SID (the conversation) when well-formed
  6. BLAVE_AGENT_LOCAL unset → `import lib` installs nothing and writes no file
  7. file over 256 KB → not written; the file a symlink → not followed; line ≤ 8 KB
  8. the original hooks still run (sys and threading), install() is idempotent, the hook's own failure is swallowed
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from lib import error_report as E  # noqa: E402

red = []


def ok(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("" if cond else "  " + str(detail)))
    if not cond:
        red.append(name)


WS = tempfile.mkdtemp(prefix="errhook-")
E.WORKSPACE = WS
E.PATH = os.path.join(WS, "state", "error_reports.jsonl")
USER_SECRET_LINE = "SECRET_SOURCE_LINE = 'my_alpha_edge'"


def put(rel, text):
    p = os.path.join(WS, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    spec = importlib.util.spec_from_file_location(rel.replace("/", "_")[:-3], p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


runner = put("lib/fake_runner.py", """
import ast, json
def run(compute_fn):
    return compute_fn({"close": [1, 2]})
def load(name, compute_fn):
    try:
        return compute_fn({})
    except Exception as e:
        raise ValueError(f"{name} v3 is unreadable: {e}") from e
def parse(src):
    return ast.parse(src)
def decode(raw):
    return json.loads(raw)
def lookup(d):
    return d["accountEquity"]
def frame():
    import pandas as pd
    return pd.DataFrame({"close": [1.0]}).loc["2026-11-16"]
""")
strat = put("strategies/my_alpha/strategy.py", f"""
def compute_signals(data):
    {USER_SECRET_LINE}
    raise KeyError("my_alpha_signal")
""")


def caught(fn):
    try:
        fn()
    except BaseException as e:   # noqa: B902 — KeyboardInterrupt is one of the cases
        return e
    raise AssertionError("did not raise")


def rec(fn):
    e = caught(fn)
    line = E.record(e, e.__traceback__)
    return json.loads(line) if line else None


# ── 1 ──
ok("1 user compute_fn raising inside the lib runner → no record", rec(lambda: runner.run(strat.compute_signals)) is None)
ok("1 user code exec'd from a string (<string>) → no record",
   rec(lambda: exec(compile("raise ValueError('x')", "<string>", "exec"))) is None)

# ── 2 ──
r = rec(lambda: runner.load("my_alpha", strat.compute_signals))
blob = json.dumps(r, ensure_ascii=False) if r else ""
ok("2 lib wrapping the user's exception → recorded", r is not None and r["exc_type"] == "ValueError", r)
ok("2 innermost frame is the lib file, the user's frames are not in the record",
   r and r["frames"][0] == {"file": "lib/fake_runner.py", "func": "load", "line": 9}
   and "strategy.py" not in blob and "compute_signals" not in blob and "strategies" not in blob, r)
ok("2 nothing from __cause__ (only the outer str(); user's source line never)",
   USER_SECRET_LINE not in blob and "Traceback" not in blob and "KeyError" not in blob.replace("\\'my_alpha_signal\\'", ""), blob)
ok("2 frames are innermost first, ours carry file/func/line, others are a bare <other>",
   r and all(set(f) == {"file"} and f["file"] == "<other>" or set(f) == {"file", "func", "line"} for f in r["frames"]), r)

# real lib path: lib/allocator.load() exec_module's a user-written allocators/<name>/allocator.py
from lib import allocator as A  # noqa: E402

E.WORKSPACE, saved_ws = REPO, E.WORKSPACE
A.ALLOCATORS_DIR = tempfile.mkdtemp(prefix="errhook-alloc-")
for name, src in (("boom", "raise RuntimeError('user allocator boom')\n"), ("noalloc", "X = 1\n")):
    os.makedirs(os.path.join(A.ALLOCATORS_DIR, name))
    with open(os.path.join(A.ALLOCATORS_DIR, name, "allocator.py"), "w") as f:
        f.write(src)
ok("2a real lib/allocator.load: the user's allocator raising at import → no record", rec(lambda: A.load("boom")) is None)
r = rec(lambda: A.load("noalloc"))
ok("2a real lib/allocator.load: lib's own check (no allocate()) → recorded at lib/allocator.py",
   r is not None and r["exc_type"] == "AttributeError" and r["frames"][0]["file"] == "lib/allocator.py", r)
E.WORKSPACE = saved_ws

# ── 3 ──
user_src = "def f(:\n    secret_strategy_code = 1\n"
r = rec(lambda: runner.parse(user_src))
blob = json.dumps(r) if r else ""
ok("3 SyntaxError from ast.parse of user code → recorded", r is not None and r["exc_type"] == "SyntaxError", r)
ok("3 …without the source line", "secret_strategy_code" not in blob and "def f(" not in blob, blob)

# ── 4 ──
r = rec(lambda: runner.decode("{bad json"))
ok("4 lib calling json.loads that raises → recorded, innermost own frame is lib",
   r is not None and r["exc_type"] == "JSONDecodeError" and r["frames"][0]["file"] == "<other>"
   and r["frames"][1]["file"] == "lib/fake_runner.py", r)
r = rec(lambda: runner.lookup({}))
ok("4 a lib KeyError of its own → recorded", r is not None and r["frames"][0]["func"] == "lookup", r)

r = rec(runner.frame)
ok("4 lib calling pandas .loc that raises KeyError → recorded (innermost frames are pandas = <other>)",
   r is not None and r["exc_type"] == "KeyError" and r["frames"][0] == {"file": "<other>"}
   and r["frames"][1]["file"] == "lib/fake_runner.py" and r["frames"][1]["func"] == "frame", r)
ok("4 runtime/ in the app bundle counts as ours", E.classify(os.path.join(REPO, "runtime", "agent_turn.py")) == "runtime/agent_turn.py")
ok("4 json's own file is library", E.classify(json.__file__) == "library")

# ── 5 ──
import requests  # noqa: E402

for name in sorted(E.EXPECTED - {"GeneratorExit", "SystemExit", "KeyboardInterrupt"}):
    cls = type(name, (RuntimeError,), {})
    ok(f"5 {name} → no record", rec(lambda: runner.run(lambda d: (_ for _ in ()).throw(cls("x")))) is None)
sub = type("PaperMarketClosed", (Exception,), {})
child = type("SomeChild", (sub,), {})
ok("5 a subclass of an expected class → no record", rec(lambda: runner.run(lambda d: (_ for _ in ()).throw(child("x")))) is None)
ok("5 KeyboardInterrupt → no record", E.record(KeyboardInterrupt(), None) is None)
ok("5 SystemExit → no record", E.record(SystemExit(1), None) is None)
for exc in (requests.exceptions.ReadTimeout("t"), requests.exceptions.ConnectionError("c"), TimeoutError("t")):
    ok(f"5 {type(exc).__name__} → no record", E._skip(exc))
http = requests.exceptions.HTTPError("400 Client Error: Bad Request for url: https://x/y?apikey=abc")
ok("5 HTTPError is not a network blip → would be recorded", not E._skip(http))
# publish()'s "fix every one, then re-send" refusal: the agent recovers in the same turn (0.1.59 card blamed it a day later)
from lib import report as _report  # noqa: E402
refused = _report.ReportRefused("publish() refused crypto-market-20261121: 7 problem(s) — fix every one, then re-send")
ok("5 the real lib.report.ReportRefused is still a ValueError (callers catching ValueError keep working)",
   isinstance(refused, ValueError))
ok("5 ReportRefused raised from lib → no record", rec(lambda: runner.run(lambda d: (_ for _ in ()).throw(refused))) is None)
with open(os.path.join(REPO, "lib", "report_templates.py"), encoding="utf-8") as f:
    tpl = f.read()
ok("5 publish()'s refusal raises ReportRefused", "raise _report.ReportRefused(_refusal(pack, problems))" in tpl
   and "raise ValueError(_refusal(" not in tpl)

# the conversation the error happened in (shell/main.js BLAVE_CHAT_SID): kept locally so the card shows only there
os.environ[E.SID_ENV] = "desktop-ab12cd"
r = rec(lambda: runner.lookup({}))
ok("5 a record carries the conversation it happened in", r is not None and r.get("sid") == "desktop-ab12cd", r)
os.environ[E.SID_ENV] = "../not-a-sid"
r = rec(lambda: runner.lookup({}))
ok("5 a malformed conversation id is left out", r is not None and "sid" not in r, r)
del os.environ[E.SID_ENV]
r = rec(lambda: runner.lookup({}))
ok("5 no conversation (cron, daemon) → no sid", r is not None and "sid" not in r, r)

# ── 6 ──
probe = ("import sys, threading; before = (sys.excepthook, threading.excepthook); import lib; "
         "print(int(sys.excepthook is before[0] and threading.excepthook is before[1]))")
env = {k: v for k, v in os.environ.items() if k != "BLAVE_AGENT_LOCAL"}
out = subprocess.run([sys.executable, "-c", probe], cwd=REPO, env=env, capture_output=True, text=True)
ok("6 BLAVE_AGENT_LOCAL unset: import lib installs no hook", out.stdout.strip() == "1", out.stdout + out.stderr)
env["BLAVE_AGENT_LOCAL"] = "1"
out = subprocess.run([sys.executable, "-c", probe], cwd=REPO, env=env, capture_output=True, text=True)
ok("6 BLAVE_AGENT_LOCAL=1: import lib installs it", out.stdout.strip() == "0", out.stdout + out.stderr)
cloud_ws = tempfile.mkdtemp(prefix="errhook-cloud-")
crash = ("import os, sys; sys.path.insert(0, %r); import lib.error_report as E; E.PATH = os.path.join(%r, 'e.jsonl'); "
         "import lib; raise ValueError('x')") % (REPO, cloud_ws)
env.pop("BLAVE_AGENT_LOCAL")
subprocess.run([sys.executable, "-c", crash], env=env, capture_output=True)
ok("6 …and a crash with it unset writes no file", not os.listdir(cloud_ws), os.listdir(cloud_ws))

# ── 7 ──
if os.path.exists(E.PATH):
    os.remove(E.PATH)
e = caught(lambda: runner.lookup({}))
line = E.record(e, e.__traceback__)
ok("7 written as one JSON line", E.write(line) and open(E.PATH).read() == line)
with open(E.PATH, "a") as f:
    f.write("x" * (E.MAX_FILE_BYTES + 1))
ok("7 file over 256 KB → not written", not E.write(line))
os.remove(E.PATH)
target = os.path.join(WS, "outside.txt")
open(target, "w").close()
os.symlink(target, E.PATH)
ok("7 the file is a symlink → not followed", not E.write(line) and open(target).read() == "")
os.remove(E.PATH)
big = caught(lambda: runner.run(lambda d: runner.lookup({"x" * 9000: 1})))
huge = type("Huge", (Exception,), {})("é" * 5000)
r = E.record(huge, caught(lambda: runner.lookup({})).__traceback__)
ok("7 line ≤ 8 KB and the message cut to fit", r and len(r.encode()) <= E.MAX_LINE_BYTES and len(json.loads(r)["message"]) <= E.MESSAGE_MAX, len(r or ""))

# ── 8 ──
seen = []
sys.excepthook = lambda *a: seen.append("sys")
threading.excepthook = lambda a: seen.append("thread")
E._installed = False
E.install()
E.install()
e = caught(lambda: runner.lookup({}))
sys.excepthook(type(e), e, e.__traceback__)
t = threading.Thread(target=lambda: runner.lookup({}))
t.start()
t.join()
ok("8 both original hooks still run, each once (install is idempotent)", seen == ["sys", "thread"], seen)
lines = open(E.PATH).read().splitlines() if os.path.exists(E.PATH) else []
ok("8 both paths recorded a line", len(lines) == 2, lines)
E.record, real = (lambda *a: (_ for _ in ()).throw(RuntimeError("hook bug"))), E.record
sys.excepthook(type(e), e, e.__traceback__)
E.record = real
ok("8 the hook's own failure is swallowed and the original still runs", seen[-1] == "sys", seen)

print()
if red:
    print(f"{len(red)} FAILED: {red}")
    sys.exit(1)
print("all ok")
