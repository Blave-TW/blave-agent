"""Turns that open a session.db which does not exist yet, all at once (fresh install, two
conversations started together), all get a working WAL connection.

The loser of the race used to raise "database is locked" on `PRAGMA journal_mode=WAL` (the
busy timeout does not cover that lock) and the whole turn failed. Each round here starts
four real processes against a new file at the same instant; the old code failed most rounds.
Also: a non-lock error is not retried, and the retries are bounded.
Run: cd blave-agent && python3 tests/check_session_store_wal.py
"""
import os, sqlite3, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
sys.path.insert(0, RUNTIME)
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  {detail}"))
    if not ok:
        fails.append(name)


CHILD = """
import sys, time
sys.path.insert(0, sys.argv[1])
import session_store as ss
start = float(sys.argv[2])
while time.time() < start:
    pass
try:
    conn = ss._conn()
    print(conn.execute("PRAGMA journal_mode").fetchone()[0])
    conn.close()
except Exception as e:
    print("ERR", e)
"""

bad = []
tmp = tempfile.mkdtemp(prefix="check-wal-")
for r in range(10):
    db = os.path.join(tmp, f"r{r}", "session.db")
    start = time.time() + 0.5
    ps = [subprocess.Popen([sys.executable, "-c", CHILD, RUNTIME, str(start)], text=True,
                           stdout=subprocess.PIPE, env={**os.environ, "BLAVE_AGENT_DB": db})
          for _ in range(4)]
    bad += [o for o in (p.communicate(timeout=60)[0].strip() for p in ps) if o != "wal"]
check("4 turns opening a fresh db at once: every one gets a WAL connection (10 rounds)", not bad, bad[:5])

import session_store as ss  # noqa: E402


class Fake:
    def __init__(self, errors, mode="wal"):
        self.errors, self.mode, self.calls = list(errors), mode, 0

    def execute(self, sql):
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return self

    def fetchone(self):
        return (self.mode,)


ss.time.sleep = lambda s: None
f = Fake([sqlite3.OperationalError("database is locked")] * 3)
ss._set_wal(f)
check("locked → retried until it takes", f.calls == 4, f.calls)
f = Fake([sqlite3.OperationalError("disk I/O error")])
try:
    ss._set_wal(f)
    raised = False
except sqlite3.OperationalError:
    raised = True
check("another error is not retried", raised and f.calls == 1, f.calls)
f = Fake([sqlite3.OperationalError("database is locked")] * 1000)
try:
    ss._set_wal(f)
    raised = False
except sqlite3.OperationalError:
    raised = True
check("bounded: still locked after WAL_TRIES → raises", raised and f.calls == ss.WAL_TRIES, f.calls)
f = Fake([], mode="delete")
ss._set_wal(f)
check("a file system that never takes WAL: gives up after WAL_MODE_TRIES, keeps its mode, no error", f.calls == ss.WAL_MODE_TRIES, f.calls)

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
sys.exit(1 if fails else 0)
