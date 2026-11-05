"""統一 login stopped: nothing goes out, the user is told once, and the worker does not linger.

The 11-04 case: a login TIMEOUT stopped the worker at 03:19, the reconciler skipped 85 rounds,
7 hours, with one lot held, and said nothing. Through the real reconcile round, the real order lib
and the real login gate (only the broker session is faked; World: check_capital_ledger_paths):

  O  orders: stopped, whatever the snapshot says (ok=false, hours stale, still fresh because the
     worker's session outlives an order's failed login): a flipped signal sends nothing, closes
     included, no login, no HALT however many rounds; agent scripts are refused too. Confirmed
     login: the book converges to the current target once, and stays there. Worker gone with no
     stop: the stale read HALTs on the third round (that P1 already speaks).
  N  venue_login_blocked: one event per stop, class and held rows only (never the broker's text),
     not for the user's own 「確認登入」, not again on a later STOPPED; an append that failed, or a stop
     file from before this notice, is sent from the reconciler's round, once, past the writer's minute.
  W  a running worker exits LOGIN_STOPPED_EXIT at the tick after an order's login stopped logins.

Run: cd blave-agent && .venv/bin/python tests/check_president_stop_orders.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="president-stop-")
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


spec = importlib.util.spec_from_file_location("ledger_paths", os.path.join(ROOT, "tests", "check_capital_ledger_paths.py"))
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
w = harness.president_world(TMP)

from datetime import datetime  # noqa: E402
from lib import account_president as ap, events, guard, order_president as op, portfolio  # noqa: E402
from lib import president_contracts as pc, president_vault as pv, president_worker as worker  # noqa: E402

pv.STOP = os.path.join(TMP, "state", "president_login_stop.json")
pv._WS = TMP
EMITS, EMIT_OK = [], [True]


def fake_emit(ev_type, **payload):
    if not EMIT_OK[0]:
        return None
    EMITS.append((ev_type, {k: v for k, v in payload.items() if v is not None}))
    return len(EMITS)


events.emit = fake_emit
session = pv.login   # the World's fake session; the gate in front of it is the real one's first lines
logins = []


def gated_login(creds, log_dir, explicit=False):
    if not explicit and pv.stopped():
        raise pv.LoginError("STOPPED")
    logins.append(1)
    return session(creds, log_dir, explicit=explicit)


pv.login = gated_login
w.setup(2)
real_now = pc._now
pc._now = lambda now: real_now(now or datetime(2026, 11, 4, 10, 0, tzinfo=pc.TAIPEI))
w.listed = {"TMF": ["TMFK6", "TMFL6"], "TXF": ["TXFK6", "TXFL6", "TXFA7"]}
from manager import reconciler as rec  # noqa: E402
rec.send_telegram = lambda *_: None
rec._read_env = lambda: {}
skew = [0.0]
_t = time.time
time.time = lambda: _t() + skew[0]


def snapshot(ok=True, **extra):
    now = time.time()
    body = ({"ok": True, "read_at": now, "query_started_at": now + 30, "account_fp": "fp1", "equity": 1e6,
             "listed": w.listed, "positions": [{"root": k[:3], "productid": k, "net": v} for k, v in w.rows.items()]}
            if ok else {"ok": False, "error": "login failed", "read_at": now})
    json.dump({**body, **extra}, open(ap._SNAPSHOT, "w"))


def round_():
    sent, n = len(w.sent), len(logins)
    try:
        portfolio.reconcile(get_positions_fn=rec._get_positions_guarded, place_order_fn=rec.place_order,
                            threshold=rec._symbol_threshold, send_telegram_fn=lambda *_: None)
        out = "ok"
    except rec.ReadSkipped:
        out = "skipped"
    except Exception as e:
        out = type(e).__name__
    return out, w.sent[sent:], len(logins) - n


# ── O ────────────────────────────────────────────────────────────────────────
w.signal(1)
snapshot()
out, sent, _n = round_()
check(out == "ok" and w.rows == {"TXFK6": 2}, "healthy: the book is built, 2 long", (out, sent, w.rows))
skew[0] += 30
snapshot()
check(round_()[1] == [], "…and converged")

pv._stop("TIMEOUT")
w.signal(-1)
skew[0] += 30
snapshot(ok=False, login_stopped=True)
out, sent, n = round_()
check(out == "skipped" and not sent and not n, "stopped, ok=false snapshot, the signal flips: skipped, nothing sent, no login", (out, sent, n))
skew[0] += 24539
results = [round_() for _ in range(6)]
check(all(r == ("skipped", [], 0) for r in results) and not guard.halted(),
      "…6.8 hours on, stale snapshot, 6 more rounds: the same, and never a HALT", results)
check(rec.place_order("TXF", -2, exchange="president", reduce_only=True) is False, "…a close leg is skipped too")
for name, fn in (("entry", lambda: op.place_futures_market_order({}, "TXF", "sell", 1, "entry")),
                 ("close", lambda: op.close_position_partial({}, "TXF", "long", 1))):
    try:
        fn()
        check(False, f"…an agent script's {name} is refused")
    except Exception as e:
        check(not isinstance(e, AssertionError), f"…an agent script's {name} is refused ({type(e).__name__})")
snapshot()
out, sent, n = round_()
check(out == "ok" and not sent and not n, "stopped, snapshot still fresh (an order's login failed, the worker reads on): nothing sent", (out, sent, n))
check(len(w.sent) == 1 and w.rows == {"TXFK6": 2}, "the account never moved through all of it", w.rows)

pv._clear()
skew[0] += 60
snapshot()
round_()
for _ in range(3):
    skew[0] += 30
    snapshot()
    round_()
check(w.rows == {"TXFK6": -2} and len(w.sent) == 3,
      "confirmed login: converges to the current target once (close 2, entry 2), no replay, no double", (w.rows, w.sent))

w.signal(1)
skew[0] += 400
results = [round_() for _ in range(3)]
check(all(not r[1] for r in results) and guard.halted(),
      "worker gone with no stop file: nothing sent, the stale read HALTs on the third round", results)
guard.clear_halt("test")

# ── N ────────────────────────────────────────────────────────────────────────
# pv.login is the World's fake from here up; a second copy of the module carries the real one
_spec = importlib.util.spec_from_file_location("president_vault_real", pv.__file__)
real_login = importlib.util.module_from_spec(_spec)
real_login.__package__ = "lib"
_spec.loader.exec_module(real_login)
real_login.STOP = pv.STOP
real_login._WS = TMP
SECRET = "A123456789 密碼錯誤"


class FakeUnitrade:
    test_mode = False
    logins = 0

    def login(self, *a):
        FakeUnitrade.logins += 1
        return types.SimpleNamespace(ok=False, error=SECRET)

    def logout(self):
        pass


sys.modules["unitrade.unitrade"].Unitrade = FakeUnitrade
PFX = os.path.join(TMP, "c.pfx")
open(PFX, "wb").write(b"x")
CREDS = {"url": "https://x", "account": "A", "password": "P", "ca_path": PFX, "ca_password": "", "live": True}
real_login.in_login_maintenance = lambda now=None: False
os.makedirs("state/logs", exist_ok=True)


def try_login(explicit=False):
    try:
        real_login.login(CREDS, os.path.join(TMP, "state", "logs"), explicit=explicit)
    except real_login.LoginError as e:
        return e.kind


def reset():
    del EMITS[:]
    EMIT_OK[0] = True
    if os.path.exists(pv.STOP):
        os.remove(pv.STOP)


reset()
w.rows = {"TMFK6": -1}
snapshot()
kind = try_login()
check(kind == "CERT_MISMATCH" and len(EMITS) == 1, "a failed login: one venue_login_blocked", (kind, EMITS))
ev = EMITS[0] if EMITS else ("", {})
check(ev[0] == "venue_login_blocked" and ev[1] == {"venue": "president", "reason": "CERT_MISMATCH", "positions": ["TMFK6 -1"]},
      "…venue, class, held rows", ev)
check(SECRET not in json.dumps(EMITS, ensure_ascii=False) and "A123456789" not in json.dumps(EMITS),
      "…never the broker's text (it can carry the national id)")
n = FakeUnitrade.logins
check(try_login() == "STOPPED" and FakeUnitrade.logins == n and len(EMITS) == 1, "a later login: STOPPED, no broker, no second event")
real_login.notify_stopped()
check(len(EMITS) == 1, "…notify_stopped on a notified stop: nothing")

reset()
check(try_login(explicit=True) == "CERT_MISMATCH" and not EMITS and real_login.stopped() == "CERT_MISMATCH",
      "the user's own 「確認登入」 failing: stopped, no P1 (he is looking at the answer)", EMITS)
real_login.notify_stopped()
check(not EMITS, "…and no retry turns it into one")

reset()
snapshot(ok=False)
EMIT_OK[0] = False
try_login()
check(not EMITS and "notified" not in json.load(open(pv.STOP)), "the append failed: the stop stands, not marked notified")
EMIT_OK[0] = True
real_login.notify_stopped(min_age=60)
check(not EMITS, "…inside the writer's minute the retry waits (no double with the writer)")
skew[0] += 61
real_login.notify_stopped(min_age=60)
check(len(EMITS) == 1 and "positions" not in EMITS[0][1], "…past it the retry sends it; no rows from an ok=false snapshot", EMITS)
real_login.notify_stopped(min_age=60)
check(len(EMITS) == 1, "…once")

reset()
json.dump({"kind": "TIMEOUT", "at": int(time.time()) - 3600}, open(pv.STOP, "w"))
rec._next_round()
check(rec._president_login_stopped() is True and [e[1]["reason"] for e in EMITS] == ["TIMEOUT"],
      "a stop from before this notice (the machine stuck today): the reconciler's next round sends it", EMITS)
rec._next_round()
rec._president_login_stopped()
check(len(EMITS) == 1, "…once")
reset()

# ── W ────────────────────────────────────────────────────────────────────────
worker.president_vault.STOP = pv.STOP
worker.maintenance = lambda now=None: None
# inside one trading window whatever the wall clock says (off hours the loop never logs in)
worker.session_window = lambda now=None: datetime(2026, 11, 5, 8, 30, tzinfo=worker.TAIPEI)
worker.OUT_PATH = ap._SNAPSHOT
worker.HEARTBEAT_PATH = os.path.join(TMP, "state", "heartbeat", "president_worker")
worker.BACKOFF_PATH = os.path.join(TMP, "state", "president_worker_backoff.json")
worker._quote_api = lambda api: None
reads = []


class WorkerApi:
    def logout(self):
        pass


worker._login = lambda explicit=False: (WorkerApi(), "A1")
worker.read_account = lambda api, actno: reads.append(1) or {"ok": True, "equity": 1.0, "positions": []}
worker._sleep_until_refresh = lambda: json.dump({"kind": "TIMEOUT", "at": int(time.time()), "notified": True}, open(pv.STOP, "w"))
try:
    worker.main()
    code = None
except SystemExit as e:
    code = e.code
snap = json.load(open(ap._SNAPSHOT))
check(code == worker.LOGIN_STOPPED_EXIT and len(reads) == 1 and snap.get("login_stopped") is True,
      "a running worker, an order's login stops logins: exits LOGIN_STOPPED_EXIT at its next tick", (code, reads, snap))

print("\ncheck_president_stop_orders: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
