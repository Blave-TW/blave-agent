"""The freeze only refuses NEW writes from the agent; it never checks what is already on disk. Machines whose agent
edited lib/data.py or the Binance libs before the freeze (three live cloud machines, 2026-11-19 fleet scan) must keep
trading: the reconciler starts and runs on those files, through secret_imports' finder, with no HALT.

  ① a workspace whose lib/data.py, the Binance libs, lib/portfolio.py and lib/guard.py carry an earlier agent edit
     (a marker each writes on import): the reconciler run the cloud way and the desktop way (local_daemon.py
     --run-reconciler) starts on them (portfolio / guard load at its start) with no state/HALT; the data and
     Binance libs load through the same finder a password process uses (no venue is bound here: no network)
  ② the guard still refuses a new write to the same files

Run: cd blave-agent && .venv/bin/python tests/check_frozen_existing_edits.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = os.path.realpath(tempfile.mkdtemp(prefix="frozen-existing-"))
WS = os.path.join(BASE, "workspace")
MARK = os.path.join(BASE, "mark")
EDITED = ("lib/data.py", "lib/order_binance.py", "lib/account_binance.py", "lib/portfolio.py", "lib/guard.py")
fails = []


def t(name, ok, got=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or got is None else f"  → {got!r}"), flush=True)
    if not ok:
        fails.append(name)


for d in ("lib", "manager"):
    shutil.copytree(os.path.join(ROOT, d), os.path.join(WS, d),
                    ignore=shutil.ignore_patterns("__pycache__", "*.json", "*.jsonl", "executors"))
os.makedirs(os.path.join(WS, "state"))
os.makedirs(MARK)
for rel in EDITED:
    with open(os.path.join(WS, rel), "a", encoding="utf-8") as f:
        f.write(f"\n\n# an agent's edit from before the freeze\nopen({os.path.join(MARK, os.path.basename(rel))!r}, 'w')"
                ".close()\n")


def env():
    keep = ("PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA")
    e = {k: v for k, v in os.environ.items() if k in keep}
    e.update(HOME=BASE, BLAVE_AGENT_WORKSPACE=WS, BLAVE_AGENT_LOCAL="1", BLAVE_AGENT_BASE=BASE,
             BLAVE_AGENT_HOME=BASE, PYTHONUNBUFFERED="1")
    return e


def run_until(argv, want, keep_stdin=False, seconds=60):
    log = os.path.join(BASE, "run-%d.log" % time.monotonic_ns())
    with open(log, "wb") as lf:
        p = subprocess.Popen([sys.executable] + argv, cwd=WS, env=env(), stdout=lf, stderr=subprocess.STDOUT,
                             stdin=subprocess.PIPE if keep_stdin else subprocess.DEVNULL)
    end = time.time() + seconds
    while time.time() < end and p.poll() is None:
        if want in open(log, encoding="utf-8", errors="replace").read():
            break
        time.sleep(0.2)
    if keep_stdin:
        p.stdin.close()
    try:
        p.wait(20)
    except subprocess.TimeoutExpired:
        p.terminate()
        p.wait(20)
    return open(log, encoding="utf-8", errors="replace").read()


for label, argv, keep in (("cloud", ["manager/reconciler.py"], False),
                          ("desktop", [os.path.join(RUNTIME, "local_daemon.py"), "--run-reconciler",
                                       os.path.join("manager", "reconciler.py")], True)):
    for f in os.listdir(MARK):
        os.remove(os.path.join(MARK, f))
    out = run_until(argv, "Reconciler started", keep_stdin=keep)
    t(f"① {label}: the reconciler starts on the pre-edited files", "Reconciler started" in out, out[-600:])
    t(f"① {label}: …running the edited lib/portfolio.py and lib/guard.py",
      {"portfolio.py", "guard.py"} <= set(os.listdir(MARK)), sorted(os.listdir(MARK)))
    t(f"① {label}: no HALT, nothing refused", not os.path.exists(os.path.join(WS, "state", "HALT"))
      and "REFUSED" not in out and "CODE_CHANGED" not in out, out[-300:])

for f in os.listdir(MARK):
    os.remove(os.path.join(MARK, f))
probe = ("import os, sys, runpy\n"
         f"si = runpy.run_path({os.path.join(WS, 'lib', 'secret_imports.py')!r})\n"
         f"si['install']({WS!r}, si['SCRIPT_SIBLINGS'])\n"
         "import lib.data, lib.order_binance, lib.account_binance\n"
         "print('imported')\n")
r = subprocess.run([sys.executable, "-c", probe], cwd=WS, env=env(), capture_output=True, text=True, timeout=120)
t("① the edited lib/data.py and Binance libs load through the finder of a password process",
  "imported" in r.stdout and {"data.py", "order_binance.py", "account_binance.py"} <= set(os.listdir(MARK)),
  (r.stdout[-200:], r.stderr[-400:]))

os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.setdefault("BLAVE_AGENT_DB", os.path.join(BASE, "session.db"))
sys.path.insert(0, RUNTIME)
sdk = types.ModuleType("claude_agent_sdk")
sdk.HookMatcher = lambda matcher=None, hooks=None: {"matcher": matcher, "hooks": hooks}
sys.modules["claude_agent_sdk"] = sdk
import agent_turn as at  # noqa: E402

t("② a new write to those files is still refused (Bash and Write/Edit)",
  all(at.secret_code_bash_denied(f"echo x >> {rel}") and at.secret_code_path(os.path.join(WS, rel)) for rel in EDITED))

shutil.rmtree(BASE, ignore_errors=True)
print("\n" + (f"{len(fails)} FAIL" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
