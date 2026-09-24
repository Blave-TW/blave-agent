"""manager/flatten.py single-flight — no network, no exchange, no crontab.

Why this exists: 暫停 and 全部平倉 are always pressable (a kill switch that
greys out mid-flight is not a kill switch), so close_all IS re-sent, and
_cmd_close_all used to Popen a detached flatten for every single press. A
second flatten re-reads positions and re-closes them; on 群益 the close is
sNewClose=2「auto 新倉/平倉」 against a snapshot up to 300s old, i.e. a real
reversed position on a real account.

Asserts: a second flatten cannot take the lock and does not wait; flatten()
reports ALREADY_RUNNING and touches nothing (never reads .env, never trips
HALT, never zeroes the ledger); a SIGKILLed holder leaves NO stale lock (the
next flatten gets it — the lock must not become a new way to brick the panic
button); a lone flatten runs to completion; and _cmd_close_all acks
close_all=already_running without launching a second process.

Run: cd blave-agent && python3 tests/check_flatten_singleflight.py
"""
import os
import signal
import subprocess
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Never let this test read the repo's .env: flatten.py chdirs to the repo ROOT
# on import, and that .env holds real exchange keys (2026-09-22 incident).
_REPO_ENV = os.path.join(ROOT, ".env")


def _no_repo_env(event, args):
    if event == "open" and args and isinstance(args[0], (str, bytes)):
        p_ = os.fsdecode(args[0])
        if os.path.abspath(p_) == _REPO_ENV:
            raise RuntimeError(f"test tried to open the repo .env ({p_})")


sys.addaudithook(_no_repo_env)
BASE = tempfile.mkdtemp(prefix="flatten-lock-")
# notify config = none: lib.notify here and in every child falls back to a log line, never a real Telegram
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)

sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, os.path.join(ROOT, "manager"))
import command_listener as cl  # noqa: E402
import flatten  # noqa: E402  (chdir's the process to ROOT — every path below is absolute)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# A holder is a real separate process taking the real lock through the real
# helper — an in-process flock would be indistinguishable from no lock at all
# (flock is per open-file-description, and re-locking your own is not the case
# under test).
HOLDER = (
    "import sys, time;"
    "sys.path.insert(0, {root!r});"
    "sys.path.insert(0, {mgr!r});"
    "import flatten;"
    "fh = flatten._singleflight(sys.argv[1]);"
    "print('held' if fh else 'refused', flush=True);"
    "time.sleep(300)"
).format(root=ROOT, mgr=os.path.join(ROOT, "manager"))

holders = []
_REAL_POPEN = subprocess.Popen  # section 5 stubs the module-wide one


def holder(path):
    """Start one and wait until it has said what happened."""
    p = _REAL_POPEN([sys.executable, "-c", HOLDER, path],
                    stdout=subprocess.PIPE, text=True)
    holders.append(p)
    return p, (p.stdout.readline().strip() or f"died({p.poll()})")


LOCK = os.path.join(BASE, "flatten.lock")

# ── 1. two at once: exactly one runs, the other does not wait ───────────────
first, said = holder(LOCK)
check(said == "held", f"first flatten takes the lock ({said})")

t0 = time.time()
second, said2 = holder(LOCK)
check(said2 == "refused", f"second flatten is refused the lock ({said2})")
check(time.time() - t0 < 20,
      "...and returns immediately — 'stop faster' must never queue behind 'stop'")
second.kill()
second.wait()

# ── 2. the refused one reports it, and does nothing else ────────────────────
touched = []
saved = (flatten.LOCK_PATH, flatten._read_env, flatten.guard,
         flatten._wait_for_inflight, flatten.load_portfolio_config,
         flatten.zero_ledger_symbols)
flatten.LOCK_PATH = LOCK
flatten._read_env = lambda *a, **k: touched.append("env") or {}
flatten.guard = types.SimpleNamespace(
    halted=lambda: touched.append("halted") or True,
    trip_halt=lambda *a, **k: touched.append("trip_halt"),
    restart_stopped=lambda: False)
flatten._wait_for_inflight = lambda *a, **k: touched.append("inflight") or []
flatten.load_portfolio_config = lambda: touched.append("cfg") or {}
flatten.zero_ledger_symbols = lambda s, venue=None: touched.append("zero")

check(flatten.flatten() == flatten.ALREADY_RUNNING,
      "flatten() under a held lock returns ALREADY_RUNNING")
check(touched == [], f"...and did nothing at all before exiting ({touched})")
check(flatten.ALREADY_RUNNING != True and flatten.EXIT_ALREADY_RUNNING not in (0, 1),  # noqa: E712
      "ALREADY_RUNNING is distinguishable from ran-clean / ran-with-errors")

# ── 3. a SIGKILLed holder leaves no stale lock ─────────────────────────────
# The lock must not become a new failure mode: a machine that crashed mid-
# flatten (or rebooted) has to be flattenable again with no cleanup step.
os.kill(first.pid, signal.SIGKILL)
first.wait()
check(os.path.isfile(LOCK), "the lock FILE survives the kill (nothing to clean up)")
third, said3 = holder(LOCK)
check(said3 == "held", f"...but the next flatten still takes it ({said3})")
third.kill()
third.wait()

# ── 4. alone, it runs to the end ───────────────────────────────────────────
touched.clear()
check(flatten.flatten() is True, "a lone flatten runs and reports success")
# no venue bound → nothing to zero (the book is zeroed per venue); the work is the
# env read and the in-flight wait, both after the lock
check("inflight" in touched and "env" in touched,
      f"...having actually done the work ({touched})")
flatten._LOCK = None  # drop the lock this process now holds, for section 5
(flatten.LOCK_PATH, flatten._read_env, flatten.guard, flatten._wait_for_inflight,
 flatten.load_portfolio_config, flatten.zero_ledger_symbols) = saved

# ── 5. the ack says so, and launches nothing ───────────────────────────────
popens = []
cl.subprocess.Popen = lambda argv, *a, **kw: popens.append(list(argv))
open(os.path.join(WS, "manager", "flatten.py"), "w").write("")
WS_LOCK = os.path.join(WS, "state", "flatten.lock")

check(cl._flatten_already_running() is False, "no lock file → the probe says free")
check(cl._in_workspace(cl._cmd_close_all, {}) == "close_all=started" and len(popens) == 1,
      "close_all with nothing running: started, one process launched")

busy, said5 = holder(WS_LOCK)
check(said5 == "held", f"a flatten now holds the workspace lock ({said5})")
check(cl._in_workspace(cl._cmd_close_all, {}) == "close_all=already_running",
      "close_all while one is running acks already_running")
check(len(popens) == 1, "...and launched NO second flatten")
check(os.path.isfile(os.path.join(WS, "state", "HALT")),
      "...while still tripping HALT — the stop half of the button always fires")
busy.kill()
busy.wait()
check(cl._in_workspace(cl._cmd_close_all, {}) == "close_all=started" and len(popens) == 2,
      "once it is gone, close_all launches again")

cl.subprocess.Popen = _REAL_POPEN
for p in holders:
    if p.poll() is None:
        p.kill()
print("FAILED" if fails else "ALL OK")
sys.exit(1 if fails else 0)
