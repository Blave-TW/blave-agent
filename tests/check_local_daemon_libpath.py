"""`lib` must be the WORKSPACE's lib in the local daemon — whatever else sys.path
holds (0.1.18 Windows: pywin32.pth puts site-packages/win32/lib on sys.path, a
directory with no __init__.py; `python runtime/local_daemon.py` has runtime/ at
sys.path[0] and the workspace nowhere, so the first `from lib import …` made
outside command_listener._in_workspace bound `lib` to that namespace package,
and a namespace package never re-points once the workspace is inserted later —
every `from lib.guard import …` after that: ModuleNotFoundError; 啟動下單 /
halt / resume / close_all all dead, the reconciler never starts).

  1. local_daemon._workspace_first: the workspace goes to sys.path[0]; a `lib`
     already bound to a namespace package is dropped and `lib.guard` resolves to
     the workspace; a `lib` that already is the workspace's is left alone (no log)
  2. wiring (source): main() calls it right after chdir and before Daemon()
     imports command_listener / president_connect; run_reconciler calls it too
  3. a real daemon, the poisoned way: PYTHONPATH holds a dir with `lib/` (no
     __init__) AND a sitecustomize that imports `lib` before main() runs (worse
     than pywin32, which only adds the path) → unsigned halt acked ok, state/HALT
     written, signed resume acked ok; the daemon's log says what it re-resolved
  4. command_listener._downtime_lib(optional=True) on a workspace without
     lib/downtime.py: None, and the ImportError is logged once (type + message),
     not swallowed
  5. command_listener._in_workspace drops a namespace `lib` on its own, so
     president_connect._login_stop reads the STOP class instead of None
     (「UNKNOWN」 on the page) when something polluted the name first
Run: cd blave-agent && .venv/bin/python tests/check_local_daemon_libpath.py
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="libpath-")
WS = os.path.join(BASE, "workspace")
POISON = os.path.join(BASE, "poison")  # stands in for site-packages/win32
os.makedirs(os.path.join(POISON, "lib"))
with open(os.path.join(POISON, "lib", "win32con.py"), "w") as f:
    f.write("X = 1\n")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__", "*.json", "*.jsonl"))
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
with open(os.path.join(WS, "manager", "wait_for_bar.py"), "w") as f:
    f.write("")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, RUNTIME)
import local_daemon as ld  # noqa: E402
import command_listener as cl  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg, flush=True)
    fails += 0 if cond else 1


def drop_lib():
    for n in [n for n in sys.modules if n == "lib" or n.startswith("lib.")]:
        del sys.modules[n]


def poison_first():
    """What the Windows daemon looked like before the fix: the poison dir ahead of
    the workspace (which is not on sys.path at all), and `lib` already bound."""
    drop_lib()
    sys.path[:] = [p for p in sys.path if p not in (WS, POISON)]
    sys.path.insert(1, POISON)  # behind runtime/, like pywin32's path behind the script dir
    import lib  # noqa: F401
    return sys.modules["lib"]


# ── 1. _workspace_first ───────────────────────────────────────────────────────
logs = []
ld._log = logs.append
m = poison_first()
check(getattr(m, "__file__", None) is None and "lib.guard" not in sys.modules,
      "[setup] a `lib` imported ahead of the workspace is pywin32's namespace package")
try:
    import lib.guard  # noqa: F401
    check(False, "[setup] lib.guard is ModuleNotFoundError while `lib` is the namespace package")
except ModuleNotFoundError:
    check(True, "[setup] lib.guard is ModuleNotFoundError while `lib` is the namespace package")
workspace_first = getattr(ld, "_workspace_first", None)
check(workspace_first is not None, "[1] local_daemon has _workspace_first")
if workspace_first:
    origin = workspace_first(WS)
    check(sys.path[0] == WS, "[1] the workspace is sys.path[0] afterwards")
    check(origin == os.path.join(WS, "lib", "__init__.py"), f"[1] `lib` resolves to the workspace: {origin}")
    check(any("re-resolving" in l for l in logs), f"[1] the drop is logged: {logs}")
    import lib.guard as g  # noqa: E402
    check(os.path.abspath(g.__file__) == os.path.join(WS, "lib", "guard.py"), "[1] lib.guard imports from the workspace")
    logs.clear()
    check(workspace_first(WS) == origin and logs == [], "[1] already the workspace's lib: nothing dropped, nothing logged")
    check(sys.path.count(WS) == 1, "[1] no duplicate sys.path entry")
else:
    drop_lib()
    sys.path.insert(0, WS)

# ── 2. wiring ─────────────────────────────────────────────────────────────────
src = open(os.path.join(RUNTIME, "local_daemon.py"), encoding="utf-8").read()
main_src = src[src.index("def main("):src.index("if __name__")]
chdir_at, first_at = main_src.find("os.chdir(ws)"), main_src.find("_workspace_first(ws)")
check(chdir_at >= 0 and 0 < first_at - chdir_at < 80 and first_at < main_src.index("Daemon(ws, secret)"),
      "[2] main(): _workspace_first(ws) right after os.chdir(ws), before Daemon() imports the listener")
rec_src = src[src.index("def run_reconciler("):src.index("class ReconcilerSupervisor")]
check("_workspace_first(ws)" in rec_src and "sys.path.insert" not in rec_src,
      "[2] run_reconciler goes through the same helper")

# ── 3. a real daemon under a poisoned interpreter ─────────────────────────────
with open(os.path.join(POISON, "sitecustomize.py"), "w") as f:
    f.write("import lib\n")  # bound before local_daemon's first line runs
SECRET = "s" * 40
ENV = dict(os.environ, BLAVE_AGENT_LOCAL="1", PYTHONPATH=POISON)
IN = os.path.join(WS, "state", "local_cmd", "in")
ACK = os.path.join(WS, "state", "local_cmd", "ack")
LOG = os.path.join(BASE, "daemon.log")


def wait(pred, seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            v = pred()
        except (OSError, ValueError):
            v = None
        if v:
            return v
        time.sleep(0.2)
    return None


def send(cmd, args=None, signed=True):
    cid = uuid.uuid4().hex
    body = json.dumps({"id": cid, "cmd": cmd, "args": args or {}, "ts": int(time.time())})
    tmp = os.path.join(IN, cid + ".json.tmp")
    with open(tmp, "w") as f:
        f.write(json.dumps({"body": body, "mac": ld.sign(SECRET, body) if signed else ""}))
    os.replace(tmp, os.path.join(IN, cid + ".json"))
    return wait(lambda: json.load(open(os.path.join(ACK, cid + ".json"))), 30) or {}


p = subprocess.Popen([sys.executable, os.path.join(RUNTIME, "local_daemon.py"), "--secret-stdin"],
                     env=ENV, stdin=subprocess.PIPE, stderr=open(LOG, "ab"))
try:
    p.stdin.write((SECRET + "\n").encode())
    p.stdin.flush()
    check(wait(lambda: os.path.isdir(IN), 20) is not None, "[3] daemon up with the poisoned PYTHONPATH")
    a = send("halt", {"reason": "libpath"}, signed=False)
    check(a.get("ok") is True and a.get("result") == "halted", f"[3] halt acked ok (lib.guard from the workspace): {a}")
    check(os.path.isfile(os.path.join(WS, "state", "HALT")), "[3] state/HALT written in the workspace")
    a = send("resume")
    check(a.get("ok") is True and str(a.get("result", "")).startswith("resumed"), f"[3] resume acked ok: {a}")
    check(not os.path.exists(os.path.join(WS, "state", "HALT")), "[3] HALT cleared")
    daemon_log = open(LOG, encoding="utf-8", errors="replace").read()
    check("lib resolved outside the workspace (namespace package) — re-resolving" in daemon_log,
          "[3] the daemon logged the re-resolve (the sitecustomize import was dropped)")
    check("ModuleNotFoundError" not in daemon_log, "[3] no ModuleNotFoundError anywhere in the daemon log")
    check(daemon_log.count("lib.downtime not importable: ImportError:") == 1
          and "downtime" in daemon_log and os.path.join(WS, "lib", "__init__.py") in daemon_log,
          "[3] resume's optional lib.downtime miss is logged once, naming where `lib` resolved")
finally:
    p.stdin.close()  # parent gone → the daemon leaves on its own; nothing else is signalled
    try:
        rc = p.wait(30)
    except subprocess.TimeoutExpired:
        p.terminate()
        rc = p.wait(10)
check(rc == 0, f"[3] daemon left on stdin EOF (rc={rc})")

# ── 4. _downtime_lib logs the ImportError once ───────────────────────────────
cl_logs = []
cl._log = cl_logs.append
cl._downtime_import_logged = False
check(cl._in_workspace(cl._downtime_lib, True) is None and cl._in_workspace(cl._downtime_lib, True) is None,
      "[4] optional=True on a workspace without lib/downtime.py → None")
hits = [l for l in cl_logs if l.startswith("lib.downtime not importable: ImportError:")]
check(len(hits) == 1 and "downtime" in hits[0], f"[4] logged once, type + message: {cl_logs}")
try:
    cl._in_workspace(cl._downtime_lib)
    check(False, "[4] optional=False still raises RuntimeError")
except RuntimeError as e:
    check("run 更新 blave agent" in str(e) and len(cl_logs) == 1, "[4] optional=False still raises RuntimeError, no second log line")

# ── 5. _in_workspace heals a namespace `lib`; _login_stop reads the STOP class ──
cl_logs.clear()
m = poison_first()
check(getattr(m, "__file__", None) is None, "[5] setup: `lib` is the namespace package again, workspace off sys.path")
with open(os.path.join(WS, "state", "president_login_stop.json"), "w") as f:
    json.dump({"kind": "PASSWORD", "at": 1}, f)
import president_connect as pc  # noqa: E402

pc._vault_import_logged = False
check(pc._login_stop() == "PASSWORD", "[5] _login_stop → the STOP class (not None → 「UNKNOWN」) through _in_workspace")
check(any("namespace package" in l and "dropped" in l for l in cl_logs), f"[5] the drop is logged by _in_workspace: {cl_logs}")
check(os.path.abspath(sys.modules["lib"].__file__) == os.path.join(WS, "lib", "__init__.py"),
      "[5] `lib` is the workspace's package afterwards")
check(pc._env_account() is None, "[5] _env_account: no .env → None, no exception")
with open(os.path.join(WS, ".env"), "w") as f:
    f.write("PRESIDENT_ACCOUNT=70000011234\n")
check(pc._env_account() == "70000011234", "[5] _env_account reads .env through the workspace vault")
# the vault's own ImportError (a workspace with no lib/president_vault.py) is logged once
os.remove(os.path.join(WS, "lib", "president_vault.py"))
drop_lib()
cl_logs.clear()
err = io.StringIO()
with contextlib.redirect_stderr(err):
    quiet = (pc._login_stop() is None and pc._env_account() is None
             and pc._env_bound_to({"account": "x", "password": "y"}) is False)
check(quiet, "[5] no vault on the workspace → None / False, no exception")
text = err.getvalue()
check(text.count("lib.president_vault not importable: ") == 1 and "ModuleNotFoundError: " in text,
      f"[5] …and the cause logged once, type + message: {text!r}")

shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
