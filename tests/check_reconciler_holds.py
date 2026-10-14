"""manager/reconciler._update_hold: every writer has its own hold file (state/execution/hold for
the workspace update and the desktop respawn, hold.amounts for the 下單設定 save); any live one
stops new rounds; one whose writer's pid is gone is removed at once (a writer killed mid-hold
must not stop every round, closes included, for 15 minutes); an old one is removed whatever it
says; a pid still alive keeps it.

Run: cd blave-agent && .venv/bin/python tests/check_reconciler_holds.py
"""
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import manager.reconciler as rec  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


tmp = tempfile.mkdtemp(prefix="holds-")
os.chdir(tmp)
os.makedirs("state/execution")
H, A = Path("state/execution/hold"), Path("state/execution/hold.amounts")
gone = subprocess.Popen([sys.executable, "-c", "pass"])
gone.wait()   # a pid that has exited (ours, by handle)

check(rec._update_hold() is False, "no hold file: rounds run")
A.write_text(f"{os.getpid()} {int(time.time())}")
check(rec._update_hold() is True and A.exists(), "hold.amounts by a live process: no round")
A.write_text(f"{gone.pid} {int(time.time())}")
check(rec._update_hold() is False and not A.exists(), "hold.amounts whose writer is gone: removed at once, rounds run")
H.write_text("not-a-pid")
check(rec._update_hold() is True and H.exists(), "an update hold without a pid: kept until its age limit")
old = time.time() - rec.UPDATE_HOLD_STALE_S - 5
os.utime(H, (old, old))
check(rec._update_hold() is False and not H.exists(), "…older than the limit: removed")
H.write_text(f"{os.getpid()} 1")
A.write_text(f"{gone.pid} 1")
check(rec._update_hold() is True and H.exists() and not A.exists(),
      "two writers: the dead one's file goes, the live one's keeps the hold")
H.unlink()
Path("state/execution/hold.amounts.tmp").write_text(f"{os.getpid()}")
check(rec._update_hold() is False, "a temp file is not a hold")

print(f"\n{fails} FAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
