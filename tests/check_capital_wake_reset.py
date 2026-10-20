"""群益's COM session is dropped when it can no longer be trusted — no Windows, no COM.

lib/order_capital keeps one login for the life of the process. On the desktop app
(BLAVE_AGENT_LOCAL=1) the reconciler lives across a closed laptop lid:
  - a poll sleep that returns far later than asked resets it (order_capital.reset_session) and the
    next order logs in again; a machine that never loaded the order lib imports nothing;
  - an order refused with a "this login is gone" code (SESSION_LOST_CODES, from the SKCOM manual)
    resets it too — the sleep may have fallen inside a round, where the poll sleep cannot see it.
A cloud machine (no BLAVE_AGENT_LOCAL) keeps its old behaviour on both counts.

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


os.environ["BLAVE_AGENT_LOCAL"] = "1"
resets = []
sys.modules["lib.order_capital"] = types.SimpleNamespace(reset_session=lambda: resets.append(1))
woke, slept = poll(rec.POLL_INTERVAL + 0.3)
check(woke is False and resets == [] and slept == [rec.POLL_INTERVAL],
      "an ordinary poll sleep keeps the session")
woke, _ = poll(rec.POLL_INTERVAL + rec.WAKE_GAP_S)
check(woke is False and resets == [], "a late wake-up inside the gap keeps it (a busy machine is not a sleep)")
woke, _ = poll(rec.POLL_INTERVAL + rec.WAKE_GAP_S + 1)
check(woke is True and resets == [1], "a sleep past the gap drops the 群益 session once")
os.environ.pop("BLAVE_AGENT_LOCAL")
woke, _ = poll(3600)
check(woke is True and resets == [1], "cloud machine (no BLAVE_AGENT_LOCAL): a clock jump resets nothing")
os.environ["BLAVE_AGENT_LOCAL"] = "1"
del sys.modules["lib.order_capital"]
woke, _ = poll(3600)
check(woke is True and "lib.order_capital" not in sys.modules,
      "no 群益 order lib loaded → nothing imported, nothing to reset")

main = open(os.path.join(SRC, "manager", "reconciler.py"), encoding="utf-8").read().split(
    "if __name__ == '__main__':", 1)[1]
check("time.sleep(" not in main and main.count("_poll_sleep()") >= 5,
      "every poll sleep of the main loop goes through _poll_sleep")

# ── the order lib: a send refused with a lost-login code drops the session ──
import importlib  # noqa: E402
oc = importlib.import_module("lib.order_capital")
oc.guard = types.SimpleNamespace(check_restart_stop=lambda *a: None, audit=lambda *a, **k: None)
oc._request_snapshot_refresh = lambda: None
sess = types.SimpleNamespace(center=types.SimpleNamespace(SKCenterLib_GetReturnCodeMessage=lambda c: "msg"))


def send(code, local):
    if local:
        os.environ["BLAVE_AGENT_LOCAL"] = "1"
    else:
        os.environ.pop("BLAVE_AGENT_LOCAL", None)
    oc._session = sess
    try:
        out = oc._send(sess, lambda: ("1234567890123" if code == 0 else "", code), {"intent": "entry"})
    except oc.CapitalError:
        out = "refused"
    return out, oc._session is None


check(oc.SESSION_LOST_CODES == {1000, 1041, 1108, 1109}, "lost-login codes = the four the SKCOM manual words as such")
check(all(send(c, True) == ("refused", True) for c in oc.SESSION_LOST_CODES),
      "desktop: every lost-login code → refused and the session dropped")
check(send(1019, True) == ("refused", False) and send(1020, True) == ("refused", False) and send(4, True) == ("refused", False),
      "desktop: any other refusal keeps the session (rate limit, unknown meaning, order errors)")
check(send(0, True) == ("1234567890123", False), "desktop: an accepted order keeps it")
check(all(send(c, False) == ("refused", False) for c in oc.SESSION_LOST_CODES), "cloud: old behaviour, nothing dropped")
oc._session = None
os.environ.pop("BLAVE_AGENT_LOCAL", None)

shutil.rmtree(TMP, ignore_errors=True)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
