"""The reconciler drops 群益's COM session after the computer slept — no Windows, no COM.

lib/order_capital keeps one login for the life of the process. On the desktop app the reconciler
lives across a closed laptop lid; a session from before the sleep is not trusted, so a poll sleep
that returns far later than asked resets it (order_capital.reset_session) and the next order logs
in again. A machine that never loaded the order lib imports nothing.

Run: cd blave-agent && .venv/bin/python tests/check_capital_wake_reset.py  (or /usr/bin/python3)
"""
import os
import shutil
import sys
import tempfile
import types

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="capital-wake-")
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
sys.path.insert(0, SRC)
from manager import reconciler as rec  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def poll(elapsed):
    clock = iter([1000.0, 1000.0 + elapsed])
    slept = []
    real = rec.time
    rec.time = types.SimpleNamespace(time=lambda: next(clock), sleep=slept.append)
    try:
        return rec._poll_sleep(), slept
    finally:
        rec.time = real


resets = []
sys.modules["lib.order_capital"] = types.SimpleNamespace(reset_session=lambda: resets.append(1))
woke, slept = poll(rec.POLL_INTERVAL + 0.3)
check(woke is False and resets == [] and slept == [rec.POLL_INTERVAL],
      "an ordinary poll sleep keeps the session")
woke, _ = poll(rec.POLL_INTERVAL + rec.WAKE_GAP_S)
check(woke is False and resets == [], "a late wake-up inside the gap keeps it (a busy machine is not a sleep)")
woke, _ = poll(rec.POLL_INTERVAL + rec.WAKE_GAP_S + 1)
check(woke is True and resets == [1], "a sleep past the gap drops the 群益 session once")
del sys.modules["lib.order_capital"]
woke, _ = poll(3600)
check(woke is True and "lib.order_capital" not in sys.modules,
      "no 群益 order lib loaded → nothing imported, nothing to reset")

main = open(os.path.join(SRC, "manager", "reconciler.py"), encoding="utf-8").read().split(
    "if __name__ == '__main__':", 1)[1]
check("time.sleep(" not in main and main.count("_poll_sleep()") >= 5,
      "every poll sleep of the main loop goes through _poll_sleep")

shutil.rmtree(TMP, ignore_errors=True)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
