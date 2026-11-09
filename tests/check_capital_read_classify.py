"""群益 worker errors: a lost link or a reply that never came skips the round, it does not HALT.

Before: every ok:false snapshot read as UNKNOWN (account_capital had no classify), so a 群益
outage of three reconcile rounds (~10 min at the 300 s heartbeat) halted the whole machine.
Asserts, with no Windows and no network:
1. capital_worker.main(): a login refused with a link code and a tick whose query failed both
   write the code into the error snapshot; _fail_and_exit stamps the snapshot again after its
   backoff sleep, so the restart's login never reads as a stale worker.
2. account_capital raises the snapshot's code; reconciler._classify: 1000/1041/1108/1109 and
   the query timeout → TRANSIENT; 602, an unknown code, no code → UNKNOWN.
3. _get_positions_guarded on real snapshot files: link-lost rounds are skipped without counting
   and never HALT; one that never ends re-sends exchange_unreachable every 2 hours (群益 only,
   persisted across a restart); an unclassified worker error still HALTs on the third round.
The transient code table equals order_capital.SESSION_LOST_CODES plus the timeout marker.

Run: cd blave-agent && python3 tests/check_capital_read_classify.py
"""
import json, os, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="capclassify-")
os.chdir(TMP)
os.makedirs("manager", exist_ok=True)
open("manager/portfolio_config.json", "w").write("{}")

from lib import account_capital, capital_worker, guard, venue_errors  # noqa: E402
from manager import reconciler as rec  # noqa: E402

SNAP = os.path.join(TMP, "state", "capital_account.json")
account_capital._SNAPSHOT = SNAP
capital_worker.OUT_PATH = SNAP
capital_worker.BACKOFF_PATH = os.path.join(TMP, "state", "capital_worker_backoff.json")
T, U = venue_errors.TRANSIENT, venue_errors.UNKNOWN
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── 1. the worker writes the code ────────────────────────────────────────────
class Stop(Exception):
    pass


def run_main(connect=None, tick=None):
    """capital_worker.main() up to its first _fail_and_exit; returns that payload."""
    got = {}

    def fail(payload):
        got.update(payload)
        raise Stop()
    w = capital_worker
    saved = (w._init_com, w._read_env, w.capital_vault.resolve, w._refuse_if_blocked, w._connect,
             w._fail_and_exit, w.threading.Thread, w._tick_snapshot, w.HEARTBEAT_PATH)
    w._init_com = lambda: None
    w._read_env = lambda: {}
    w.capital_vault.resolve = lambda env: ("A123456789", "pw")
    w._refuse_if_blocked = lambda *a, **k: None
    w._connect = connect or (lambda *a, **k: (None, None, "TF1", None, ()))
    w._fail_and_exit = fail
    w.threading.Thread = lambda *a, **k: type("T", (), {"start": lambda self: None})()
    w._tick_snapshot = tick or (lambda *a: {"ok": True})
    w.HEARTBEAT_PATH = w.Path(TMP) / "state" / "heartbeat" / "capital_worker"
    try:
        w.main()
    except Stop:
        pass
    finally:
        (w._init_com, w._read_env, w.capital_vault.resolve, w._refuse_if_blocked, w._connect,
         w._fail_and_exit, w.threading.Thread, w._tick_snapshot, w.HEARTBEAT_PATH) = saved
    return got


def refuse_login(*a, **k):
    raise capital_worker.ProbeError("login", "login failed code=1108 network", 1108)


def query_lost(*a):
    capital_worker._check_query_code(1041, "GetFutureRights")


def query_silent(*a):
    raise capital_worker.QueryFailed("GetOpenInterest: no ## terminator within timeout",
                                     capital_worker.QUERY_TIMEOUT)


check(run_main(connect=refuse_login).get("code") == 1108, "a refused login writes its code (1108)")
check(run_main(tick=query_lost).get("code") == 1041, "a query refused with a code writes it (1041)")
check(run_main(tick=query_silent).get("code") == capital_worker.QUERY_TIMEOUT,
      "a query whose reply never came writes the timeout marker")

clock = {"t": 1_000_000.0}
stamps = []
real_time = capital_worker.time


class FakeTime:
    @staticmethod
    def time():
        return clock["t"]

    @staticmethod
    def sleep(s):
        clock["t"] += s


def stamp(payload):
    stamps.append(clock["t"])
    real_write(payload)


real_write = capital_worker._write_snapshot
capital_worker.time, capital_worker._write_snapshot = FakeTime, stamp
with open(capital_worker.BACKOFF_PATH, "w") as f:
    json.dump({"failures": 9}, f)  # the 300 s rung
try:
    capital_worker._fail_and_exit({"ok": False, "error": "x", "code": 1041})
except SystemExit:
    pass
capital_worker.time, capital_worker._write_snapshot = real_time, real_write
check(len(stamps) == 2 and stamps[1] - stamps[0] == capital_worker.BACKOFF_MAX_S,
      f"_fail_and_exit stamps the error snapshot before and after its backoff sleep: {stamps}")


# ── 2. account_capital raises the code, the reconciler classifies it ─────────
def write(payload, age=0):
    os.makedirs(os.path.dirname(SNAP), exist_ok=True)
    with open(SNAP, "w") as f:
        json.dump(dict(payload, read_at=time.time() - age), f)


def raised(payload, age=0):
    write(payload, age)
    try:
        account_capital.get_positions({})
    except Exception as e:
        return e
    return None


from lib import order_capital  # noqa: E402  account_capital may not import it (an order lib marks a money process)
check({str(c) for c in order_capital.SESSION_LOST_CODES} | {capital_worker.QUERY_TIMEOUT}
      == account_capital._TRANSIENT_CODES,
      "the read side's transient codes = order_capital.SESSION_LOST_CODES + the worker's timeout marker")
for code in (1000, 1041, 1108, 1109, capital_worker.QUERY_TIMEOUT):
    e = raised({"ok": False, "error": "x", "code": code})
    check(rec._classify("capital", e) == T, f"code {code} → transient")
for code in (602, 9999, None):
    e = raised({"ok": False, "error": "x", "code": code})
    check(rec._classify("capital", e) == U, f"code {code} → unknown")
e = raised({"ok": False, "error": "login failed code=1041"})
check(rec._classify("capital", e) == U, "a snapshot from before the field (no code) stays unknown")
e = raised({"ok": True, "positions": []}, age=account_capital._STALE_S + 5)
check(rec._classify("capital", e) == U, "a stale snapshot (worker dead) stays unknown")
check("capital worker error" in str(raised({"ok": False, "error": "x", "code": 1041})),
      "the error text is unchanged")


# ── 3. the reconciler's read wrapper ─────────────────────────────────────────
sent, emitted = [], []
rec.send_telegram = sent.append
rec.events.emit = lambda t, **p: emitted.append((t, p))
rec._read_env = lambda: {}
rec._current_venue = lambda: "capital"
rec._capital_login_stopped = lambda: False
rec.get_positions = lambda: account_capital.get_positions({})


def reset():
    guard.clear_halt("test")
    rec._consecutive_failures = 0
    rec._reset_outage()
    rec._halt_file_seen = False
    del sent[:], emitted[:]


def rnd(now):
    try:
        rec._get_positions_guarded(now=now)
        return "ok"
    except rec.ReadSkipped:
        return "skip"
    except Exception as e:
        return e


reset()
write({"ok": False, "error": "login failed code=1108 network", "code": 1108})
outs = [rnd(t) for t in range(0, 2400, 300)]
check(all(o == "skip" for o in outs), "every link-lost round is skipped (no orders)")
check(rec._consecutive_failures == 0 and not guard.halted(), "a 40-min 群益 outage never counts or HALTs")
check([p for t, p in emitted if t == "exchange_unreachable"] == [{"venue": "capital", "minutes": 30, "code": "1108"}],
      f"exchange_unreachable once at 30 min: {emitted}")

# a 群益 outage that never ends (Wei 11-09): still no HALT, the notice goes out again every 2 hours
reset()
write({"ok": False, "error": "RuntimeError: GetOpenInterest: no ## terminator within timeout", "code": "timeout"})
for t in range(0, 6 * 3600, 300):
    rnd(t)
mins = [p["minutes"] for t, p in emitted if t == "exchange_unreachable"]
check(not guard.halted() and mins == [30, 150, 270], f"6 h of timeouts: no HALT, notices at 30/150/270 min: {mins}")
saved = json.load(open(rec.OUTAGE_PATH))
check(saved.get("announced_at") == 270 * 60, f"the last notice time is persisted: {saved}")
check(rec._load_outage(now=saved["last"])["announced_at"] == 270 * 60, "a restarted reconciler keeps the 2-hour clock")
with open(rec.OUTAGE_PATH, "w") as f:
    json.dump({k: v for k, v in saved.items() if k != "announced_at"}, f)
check(rec._load_outage(now=saved["last"])["announced_at"] == rec.UNREACHABLE_EVENT_AFTER_S,
      "a save from before the field counts its one notice at the 30-minute mark")
# announced with no time at all (an in-memory state no loader repaired): the repeat still goes out
reset()
rec._outage.update(since=0, venue="capital", announced=True, last=0, announced_at=None)
rnd(3 * 3600)
check([p["minutes"] for t, p in emitted if t == "exchange_unreachable"] == [180],
      "announced without a time: the next round re-sends instead of never repeating")

# other venues keep their one notice per outage
reset()
real_classify = rec._classify
rec._current_venue = lambda: "okx"
rec._classify = lambda venue, e: T


def busy():
    raise RuntimeError("busy")


rec.get_positions = busy
for t in range(0, 6 * 3600, 300):
    rnd(t)
check([p["minutes"] for t, p in emitted if t == "exchange_unreachable"] == [30],
      "a crypto venue's outage still emits once")
rec._current_venue = lambda: "capital"
rec._classify = real_classify
rec.get_positions = lambda: account_capital.get_positions({})

reset()
write({"ok": False, "error": "RuntimeError: GetOpenInterest: unknown 買賣別 'X'"})
for t in (0, 300, 600):
    rnd(t)
check(guard.halted(), "an unclassified worker error still HALTs on the third round")
guard.clear_halt("test")

print(f"\n{'ALL OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
