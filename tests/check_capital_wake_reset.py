"""群益's COM session is dropped when it can no longer be trusted — no Windows, no COM.

lib/order_capital keeps one login for the life of the process. On the desktop app
(BLAVE_AGENT_LOCAL=1) the reconciler lives across a closed laptop lid:
  - a poll sleep that returns far later than asked resets it (order_capital.reset_session) and the
    next order logs in again; a machine that never loaded the order lib imports nothing;
  - an order refused with a "this login is gone" code (SESSION_LOST_CODES, from the SKCOM manual)
    resets it too — the sleep may have fallen inside a round, where the poll sleep cannot see it —
    and the re-login after it backs off (30 s doubling to 2 min, no shortcut for closes) while the
    network stays down.
A cloud machine (no BLAVE_AGENT_LOCAL) keeps its old behaviour on both counts.

Run: cd blave-agent && .venv/bin/python tests/check_capital_wake_reset.py  (or /usr/bin/python3)
"""
import os
import shutil
import sys
import tempfile
import time
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
oc._RELOGIN_PATH = os.path.join(TMP, "capital_relogin.json")   # never the repo's state/
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

# ── re-login after a lost login backs off: 60 s, doubling, capped at 10 min; a good login clears it ──
os.environ["BLAVE_AGENT_LOCAL"] = "1"
clock = [5000.0]
logins = []
real_time = oc.time
oc.time = types.SimpleNamespace(time=lambda: clock[0], sleep=lambda s: None)
oc._relogin.update(n=0, until=0.0, loaded=True)


def fake_login(env):
    logins.append(clock[0])
    if fake_login.fail:
        raise oc.CapitalError("login failed code=1108")
    return sess


real_new = oc._new_session
oc._new_session = fake_login
fake_login.fail = True


def get():
    try:
        return oc._get_session({}) is sess
    except oc.CapitalError:
        return False


send(1041, True)
gaps = []
for _ in range(7):
    t0 = clock[0]
    check(get() is False and len(logins) == len(gaps), "inside the backoff: no login attempted") if gaps else None
    clock[0] = oc._relogin["until"] + 0.1
    get()
    gaps.append(round(clock[0] - t0))
check(gaps == [30, 60, 120, 120, 120, 120, 120] and len(logins) == 7,
      f"lost login → re-login waits 30 s, doubling to 120 s, one attempt each ({gaps}, {len(logins)} logins)")
# a stop / close inside the backoff gets no shortcut (each attempt is a full Login; 9997 = five
# failed logins and the process can send nothing until it restarts)
oc.guard = types.SimpleNamespace(check_restart_stop=lambda *a: None, audit=lambda *a, **k: None)
oc._check_halt = lambda fields: None
clock[0] = oc._relogin["until"] - 10
n0 = len(logins)
try:
    oc.place_futures_market_order({}, "TM0000", "sell", 1, intent="reduce")
    refused = False
except oc.CapitalError as e:
    refused = "not retried yet" in str(e)
check(refused and len(logins) == n0, "inside the backoff a reduce order is refused too, no extra login")
fake_login.fail = False
clock[0] = oc._relogin["until"] + 0.1
check(get() is True and (oc._relogin["n"], oc._relogin["until"]) == (0, 0.0) and not os.path.exists(oc._RELOGIN_PATH),
      "a good login clears the backoff (and its file)")
oc._session = None
logins.clear()
fake_login.fail = True
check(get() is False and get() is False and len(logins) == 2,
      "a first login that fails (no lost-login code before it) retries at once as before")
oc._session = None
oc._new_session, oc.time = real_new, real_time
oc._relogin.update(n=0, until=0.0, loaded=True)

# ── 9997 (five failed logins, "restart the API"): desktop flags a fresh process, backoff carries over ──
center = types.SimpleNamespace(SKCenterLib_Login=lambda i, p: login_calls.append(1) or 9997,
                               SKCenterLib_GetReturnCodeMessage=lambda c: "limit")
login_calls = []
saved = (oc._init_com, oc.capital_vault, getattr(oc, "comtypes", None), getattr(oc, "sk", None))
oc._init_com = lambda: None
oc.capital_vault = types.SimpleNamespace(resolve=lambda env: ("A123456789", "pw"), login_blocked=lambda *a: None,
                                         set_log_path=lambda c: None, record_login=lambda *a: None)
oc.comtypes = types.SimpleNamespace(client=types.SimpleNamespace(CreateObject=lambda cls, interface=None: center,
                                                                 GetEvents=lambda o, e: None))
oc.sk = types.SimpleNamespace(SKCenterLib=1, ISKCenterLib=1, SKReplyLib=1, ISKReplyLib=1, SKOrderLib=1, ISKOrderLib=1)


def fresh_process():
    oc._session = None
    oc._relogin.update(n=0, until=0.0, loaded=False)
    oc._restart["needed"] = False


fresh_process()
check(get() is False and oc.restart_needed() is True and oc._relogin["n"] == 1 and os.path.exists(oc._RELOGIN_PATH),
      "desktop: a 9997 login → restart_needed, backoff armed and written to disk")
fresh_process()
login_calls.clear()
check(get() is False and login_calls == [] and oc._relogin["n"] == 1,
      "the fresh reconciler reads the backoff: no login at start, so a 9997 that survives restarts is no storm")
oc._relogin["until"] = time.time() - 1
check(get() is False and login_calls == [1] and oc._relogin["n"] == 2, "…after it, one attempt; another 9997 doubles the wait")
os.environ.pop("BLAVE_AGENT_LOCAL")
os.remove(oc._RELOGIN_PATH)
fresh_process()
check(get() is False and oc.restart_needed() is False and not os.path.exists(oc._RELOGIN_PATH),
      "cloud: a 9997 changes nothing (no restart flag, no file)")
oc._init_com, oc.capital_vault, oc.comtypes, oc.sk = saved
fresh_process()

# ── the reconciler leaves between rounds when the order lib asks for it ──
flag = [True]
sys.modules["lib.order_capital"] = types.SimpleNamespace(restart_needed=lambda: flag[0])
os.environ["BLAVE_AGENT_LOCAL"] = "1"
due = rec._capital_restart_due()
flag[0] = False
not_due = rec._capital_restart_due()
flag[0] = True
os.environ.pop("BLAVE_AGENT_LOCAL")
cloud_due = rec._capital_restart_due()
sys.modules["lib.order_capital"] = types.SimpleNamespace()
os.environ["BLAVE_AGENT_LOCAL"] = "1"
old_lib = rec._capital_restart_due()
sys.modules["lib.order_capital"] = oc
check(due is True and not_due is False and cloud_due is False and old_lib is False,
      "restart due only on the desktop, only when the lib says so (an older lib without the hook: never)")
loop = main.split("while True:", 1)[1]
first = loop.strip().split("\n", 1)[0]
check(first == "if _capital_restart_due():" and loop.index("sys.exit(CAPITAL_RESTART_EXIT)") < loop.index("_round_marker(True)"),
      "the exit is the first thing a loop pass does — between rounds, never with a leg in flight")
os.environ.pop("BLAVE_AGENT_LOCAL", None)

shutil.rmtree(TMP, ignore_errors=True)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
