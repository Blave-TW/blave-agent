"""統一期貨 worker: a fresh login before each session, no session across maintenance or after
hours, one retry on a TIMEOUT (no broker, fake clock).

2026-11-05: a session held through the 06:00–07:30 account window went stale; its 07:30
re-login was refused (UNKNOWN) and every order stopped until the user pressed 「確認登入」.
2026-11-04 03:23: the same for a TIMEOUT (統一 posted a 03:30 login outage that night).

1. Trading windows (Mon–Fri Taipei): 08:30–14:00 and 14:45–05:15; weekends none.
2. Outside a window: logged out, the last snapshot carried as `maintenance` 'closed'; a
   restart after hours carries the on-disk snapshot read after the last close.
3. Each window opens with one fresh login; a whole weekday is 2 logins (+1 for the night
   window carried in from the day before), Fri→Mon is 4.
4. TIMEOUT (any: refused, read timeout, a hung login): the first in a row writes no stop and
   is retried LOGIN_RETRY_S later; the second in a row stops, P1 once. The count is shared
   with the order lib's logins and cleared by any login that passes.
5. PASSWORD / CERT_MISMATCH / UNKNOWN stop at once; UNKNOWN keeps the sanitized broker text
   locally; 統一's documented wrong-password / no-such-id codes are PASSWORD.

Run: cd blave-agent && python3 tests/check_president_login_drop.py
"""
import contextlib, io, json, os, sys, tempfile, threading, time, types
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
TMP = tempfile.mkdtemp(prefix="president-drop-")
os.chdir(TMP)
os.makedirs(os.path.join(TMP, "state"), exist_ok=True)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


LOGIN_SCRIPT, READS, NOTIFIED, SNAPS, CLOCKS = [], [], [], [], []


class Resp:
    def __init__(self, ok, error=""):
        self.ok, self.error = ok, error


OK = Resp(True)


class FakeUnitrade:
    logins = 0

    def __init__(self):
        self.test_mode = True

    def login(self, url, user, pw, ca, ca_pw):
        FakeUnitrade.logins += 1
        nxt = LOGIN_SCRIPT.pop(0) if LOGIN_SCRIPT else OK
        return nxt() if callable(nxt) else nxt

    def logout(self):
        pass

    def get_accounts(self):
        return ["A1"]


_ut = types.ModuleType("unitrade")
_utu = types.ModuleType("unitrade.unitrade")
_utu.Unitrade = FakeUnitrade
sys.modules["unitrade"], sys.modules["unitrade.unitrade"] = _ut, _utu

from lib import president_vault as pv, president_worker as pw  # noqa: E402

T = lambda *a: datetime(*a, tzinfo=pw.TAIPEI)  # noqa: E731


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return CLOCKS[0].astimezone(tz)


class FakeTime:
    """The worker's and the vault's `time`: time() follows the fake clock, sleep() is free."""

    def __getattr__(self, name):
        return getattr(time, name)

    @staticmethod
    def time():
        return CLOCKS[0].timestamp()

    @staticmethod
    def sleep(s):
        pass


pw.datetime = pv.datetime = FakeDT
pw.time = pv.time = FakeTime()
PFX = os.path.join(TMP, "cert.pfx")
open(PFX, "wb").close()
pv.resolve = lambda _ignored=None: {"url": "https://test167.testpfctrade.com", "account": "A1", "password": "P",
                                    "ca_path": PFX, "ca_password": "", "live": False}
pv.STOP = os.path.join(TMP, "state", "president_login_stop.json")
pv.notify_stopped = lambda min_age=0: NOTIFIED.append(pv.stopped())
pw.SDK_LOG_DIR = os.path.join(TMP, "state", "president_logs")
pw.HEARTBEAT_PATH = os.path.join(TMP, "state", "heartbeat", "president_worker")
pw.BACKOFF_PATH = os.path.join(TMP, "state", "president_worker_backoff.json")
pw.PROBE_PATH = os.path.join(TMP, "state", "president_probe.json")
pw.OUT_PATH = os.path.join(TMP, "state", "president_account.json")
pw._quote_api = lambda api: None
_real_write_snapshot = pw._write_snapshot
pw._write_snapshot = SNAPS.append


def _read(api, actno):
    nxt = READS.pop(0) if READS else True
    if isinstance(nxt, BaseException):
        raise nxt
    return {"ok": True, "equity": 1.0, "margin_error": None, "positions": [], "data_at": int(CLOCKS[0].timestamp())}


pw.read_account = _read


class _Done(Exception):
    pass


def _tick():
    CLOCKS.pop(0)
    if not CLOCKS:
        raise _Done


pw._sleep_until_refresh = _tick


def run(clocks, logins=(), reads=(), keep_count=False, disk=None):
    """main() through `clocks` (one per loop pass) → (exit code or 'ran', logins made, stop kind)."""
    for p in (pv.STOP, pw.BACKOFF_PATH, pw.OUT_PATH) + (() if keep_count else (pv._timeouts_path(),)):
        os.path.exists(p) and os.remove(p)
    if disk:
        json.dump(disk, open(pw.OUT_PATH, "w", encoding="utf-8"))
    CLOCKS[:], LOGIN_SCRIPT[:], READS[:], SNAPS[:], NOTIFIED[:] = list(clocks), list(logins), list(reads), [], []
    n = FakeUnitrade.logins
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            pw.main()
        code = "returned"
    except SystemExit as e:
        code = e.code
    except _Done:
        code = "ran"
    return code, FakeUnitrade.logins - n, pv.stopped()


def minutes(start, end, step=1):
    out, t = [], start
    while t < end:
        out.append(t)
        t += timedelta(minutes=step)
    return out


STALE = RuntimeError("get_position failed: session expired")
TIMEOUT = Resp(False, "Timeout")
STOPPED = pw.LOGIN_STOPPED_EXIT

# ── 1. windows ───────────────────────────────────────────────────────────────
W = pw.session_window
cases = [(T(2026, 11, 5, 8, 29), None), (T(2026, 11, 5, 8, 30), T(2026, 11, 5, 8, 30)),
         (T(2026, 11, 5, 13, 59), T(2026, 11, 5, 8, 30)), (T(2026, 11, 5, 14, 0), None),
         (T(2026, 11, 5, 14, 45), T(2026, 11, 5, 14, 45)), (T(2026, 11, 6, 3, 23), T(2026, 11, 5, 14, 45)),
         (T(2026, 11, 6, 5, 15), None), (T(2026, 11, 5, 7, 30), None), (T(2026, 11, 5, 5, 40), None),
         (T(2026, 11, 7, 3, 0), T(2026, 11, 6, 14, 45)), (T(2026, 11, 7, 15, 0), None),
         (T(2026, 11, 8, 20, 0), None), (T(2026, 11, 9, 3, 0), None), (T(2026, 11, 9, 8, 30), T(2026, 11, 9, 8, 30))]
bad = [(c, W(c), w) for c, w in cases if W(c) != w]
check(not bad, "trading windows 08:30–14:00 / 14:45–05:15 Mon–Fri (Friday night runs into Saturday), none on weekends", bad)
check(pw.last_close(T(2026, 11, 9, 8, 0)) == T(2026, 11, 7, 5, 0)
      and pw.last_close(T(2026, 11, 5, 14, 10)) == T(2026, 11, 5, 13, 45),
      "last close: Monday 08:00 → Saturday 05:00; Thursday 14:10 → 13:45")

# ── 2/3. the 11-05 replay and a day's logins ────────────────────────────────
r = run([T(2026, 11, 4, 14, 45), T(2026, 11, 5, 5, 10), T(2026, 11, 5, 5, 20), T(2026, 11, 5, 6, 30),
         T(2026, 11, 5, 7, 30, 30), T(2026, 11, 5, 8, 0), T(2026, 11, 5, 8, 30), T(2026, 11, 5, 8, 31)])
check(r == ("ran", 2, None), "11-05: night session logged out at 05:15, nothing at 07:30, one fresh login at 08:30", r)
check(SNAPS[2].get("maintenance") == "closed" and SNAPS[3].get("maintenance") == "account" and SNAPS[3].get("ok") is True,
      "…after hours the last read is carried as 'closed', inside the broker window as 'account'", SNAPS[2:4])
r = run([T(2026, 11, 5, 13, 59), T(2026, 11, 5, 14, 45)])
check(r == ("ran", 2, None), "a session still held when the next window starts is replaced by a fresh login", r)
r = run(minutes(T(2026, 11, 5, 0, 0), T(2026, 11, 6, 0, 0)))
check(r == ("ran", 3, None), "Thursday 00:00→24:00 at a 1-min tick: Wednesday's night window + 08:30 + 14:45 = 3 logins", r)
r = run(minutes(T(2026, 11, 6, 6, 0), T(2026, 11, 9, 23, 59), step=2))
check(r == ("ran", 4, None), "Fri 06:00 → Mon 23:59: Fri 08:30, Fri 14:45, Mon 08:30, Mon 14:45 — nothing on the weekend", r)
after_close = int(T(2026, 11, 7, 5, 10).timestamp())
r = run([T(2026, 11, 8, 10, 0), T(2026, 11, 8, 20, 0)],
        disk={"ok": True, "equity": 5.0, "positions": [], "data_at": after_close})
check(r == ("ran", 0, None) and SNAPS[-1].get("ok") is True and SNAPS[-1].get("maintenance") == "closed",
      "restart on Sunday: the snapshot read after Saturday's 05:00 close is carried, no login", (r, SNAPS[-1:]))
r = run([T(2026, 11, 8, 10, 0)], disk={"ok": True, "equity": 5.0, "positions": [], "data_at": after_close - 3600})
check(r == ("ran", 0, None) and SNAPS[-1].get("ok") is False, "…a read from before that close is not carried", SNAPS[-1:])

# ── 4. TIMEOUT: one retry, the second in a row stops ────────────────────────
r = run([T(2026, 11, 5, 8, 30), T(2026, 11, 5, 8, 32), T(2026, 11, 5, 8, 35, 1), T(2026, 11, 5, 8, 36)],
        logins=[TIMEOUT, OK])
check(r == ("ran", 2, None) and not NOTIFIED and not os.path.exists(pv._timeouts_path()),
      "08:30 TIMEOUT: no stop, no login at 08:32, retried at 08:35 and passes (count cleared)", r)
for label, first in (("Timeout", TIMEOUT), ("read timed out", Resp(False, "Read timed out. (read timeout=30)")),
                     ("connection refused", Resp(False, "Max retries exceeded (Caused by NewConnectionError("
                                                        "'Failed to establish a new connection'))"))):
    r = run([T(2026, 11, 5, 8, 30), T(2026, 11, 5, 8, 35, 1)], logins=[first, TIMEOUT])
    check(r == (STOPPED, 2, "TIMEOUT") and NOTIFIED == ["TIMEOUT"] and SNAPS[-1].get("login_stopped"),
          f"{label}, then Timeout: the second in a row stops, P1 once — 2 logins", (r, NOTIFIED))
real_lt = pv.LOGIN_TIMEOUT_S
pv.LOGIN_TIMEOUT_S = 0.05
hang = threading.Event()
r = run([T(2026, 11, 5, 8, 30)], logins=[lambda: hang.wait(0.3) or OK])
pv.LOGIN_TIMEOUT_S = real_lt
check(r == ("ran", 1, None) and not NOTIFIED, "a login hanging past LOGIN_TIMEOUT_S is a TIMEOUT: the first does not stop", r)
r = run([T(2026, 11, 4, 3, 22), T(2026, 11, 4, 3, 23, 51), T(2026, 11, 4, 3, 28, 52)],
        logins=[OK, TIMEOUT, OK], reads=[True, STALE])
check(r == ("ran", 3, None) and not NOTIFIED, "11-04 03:23: a dropped night session's re-login times out, 5 min later it passes", r)
r = run([T(2026, 11, 4, 3, 22), T(2026, 11, 4, 3, 23, 51), T(2026, 11, 4, 3, 28, 52)],
        logins=[OK, TIMEOUT, TIMEOUT], reads=[True, STALE])
check(r == (STOPPED, 3, "TIMEOUT") and NOTIFIED == ["TIMEOUT"], "…and when that one times out too, it stops", r)
for p in (pv.STOP, pv._timeouts_path()):
    os.path.exists(p) and os.remove(p)
CLOCKS[:] = [T(2026, 11, 5, 10, 0)]
LOGIN_SCRIPT[:] = [TIMEOUT]
e = None
try:
    pv.login(pv.resolve(), pw.SDK_LOG_DIR)
except pv.LoginError as x:
    e = x
check(e is not None and e.retry and pv.stopped() is None, "an order's login that times out: no stop, a retry is allowed")
r = run([T(2026, 11, 5, 14, 45)], logins=[TIMEOUT], keep_count=True)
check(r == (STOPPED, 1, "TIMEOUT"), "…the worker's next TIMEOUT is the second in a row on this machine: stops", r)
open(pv._timeouts_path(), "w").write("{not json")
r = run([T(2026, 11, 5, 8, 30)], logins=[TIMEOUT], keep_count=True)
check(r == (STOPPED, 1, "TIMEOUT"), "an unreadable count stops (it must not buy another try)", r)

# ── 5. other classes stop at once ────────────────────────────────────────────
for label, resp, kind in (("統一's wrong-password reply", Resp(False, "服務中台發生錯誤-994-[SP000101][001]輸入資料錯誤，請洽客服中心"), "PASSWORD"),
                          ("統一's no-such-id reply", Resp(False, "服務中台發生錯誤-994-[AG000005][001][007]查無資料"), "PASSWORD"),
                          ("certificate of another id", Resp(False, ":!! A123456789 {subject}"), "CERT_MISMATCH"),
                          ("an unclassified refusal", Resp(False, "<html>503 Service Unavailable</html>"), "UNKNOWN")):
    r = run([T(2026, 11, 5, 8, 30)], logins=[resp])
    stop = json.load(open(pv.STOP, encoding="utf-8"))
    check(r == (STOPPED, 1, kind) and NOTIFIED == [kind], f"{label}: {kind}, stops at the first login", (r, NOTIFIED))
    if kind == "UNKNOWN":
        check(stop.get("detail") == "<html>503 Service Unavailable</html>", "UNKNOWN keeps the broker's text in the local stop file", stop)
    else:
        check("detail" not in stop and "A123456789" not in json.dumps(stop), f"{kind} keeps the class only", stop)

# 「確認登入」: a pass clears the TIMEOUT count; a TIMEOUT under the user's press stops at once
for p in (pv.STOP, pv._timeouts_path()):
    os.path.exists(p) and os.remove(p)
json.dump({"count": 1, "at": 0}, open(pv._timeouts_path(), "w"))
CLOCKS[:] = [T(2026, 11, 5, 10, 0)]
LOGIN_SCRIPT[:] = [OK]
with contextlib.redirect_stdout(io.StringIO()):
    rc = pw.run_once()
check(rc == 0 and not os.path.exists(pv._timeouts_path()), "a 「確認登入」 that passes clears the TIMEOUT count")
LOGIN_SCRIPT[:] = [TIMEOUT]
with contextlib.redirect_stdout(io.StringIO()):
    rc = pw.run_once()
check(rc == 2 and pv.stopped() == "TIMEOUT", "a 「確認登入」 that times out stops at once (the user sees the answer)")

# ── 6. one login at a time on the machine (worker, orders, 「確認登入」) ───────
for p in (pv.STOP, pv._timeouts_path()):
    os.path.exists(p) and os.remove(p)
json.dump({"count": 1, "at": 0}, open(pv._timeouts_path(), "w"))   # one TIMEOUT already spent
CLOCKS[:] = [T(2026, 11, 5, 10, 0)]
gate = threading.Event()
LOGIN_SCRIPT[:] = [lambda: gate.wait(5) and TIMEOUT]
got = {}


def _try(name):
    try:
        pv.login(pv.resolve(), pw.SDK_LOG_DIR)
        got[name] = "OK"
    except pv.LoginError as x:
        got[name] = x.kind


n = FakeUnitrade.logins
a = threading.Thread(target=_try, args=("first",))
a.start()
while FakeUnitrade.logins == n:   # the first login is now at the broker, holding the lock
    time.sleep(0.01)
b = threading.Thread(target=_try, args=("second",))
b.start()
time.sleep(0.3)
second_waited = b.is_alive()
gate.set()
a.join(10)
b.join(10)
check(second_waited and got == {"first": "TIMEOUT", "second": "STOPPED"} and FakeUnitrade.logins == n + 1,
      "two logins at once with one TIMEOUT spent: the second waits, then reads the stop the first wrote — "
      "never a third try", (second_waited, got, FakeUnitrade.logins - n))

import subprocess  # noqa: E402
os.path.exists(pv.STOP) and os.remove(pv.STOP)
lock = os.path.join(os.path.dirname(pv.STOP), "president_login.lock")
holder = subprocess.Popen([sys.executable, "-c", "import fcntl,os,sys,time\n"
                           f"fd=os.open({lock!r}, os.O_CREAT|os.O_RDWR); fcntl.flock(fd, fcntl.LOCK_EX)\n"
                           "print('HELD', flush=True); sys.stdin.readline()"],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) if pv.fcntl else None
if holder:
    holder.stdout.readline()
    pv.time, real_wait = time, pv.LOGIN_LOCK_WAIT_S
    pv.LOGIN_LOCK_WAIT_S = 0.5
    n = FakeUnitrade.logins
    try:
        pv.login(pv.resolve(), pw.SDK_LOG_DIR)
        busy = None
    except pv.LoginError as x:
        busy = x.kind
    pv.time, pv.LOGIN_LOCK_WAIT_S = FakeTime(), real_wait
    holder.stdin.write("\n")
    holder.stdin.flush()
    holder.wait(10)
    check(busy == "BUSY" and FakeUnitrade.logins == n and pv.stopped() is None,
          "another process holds the login lock past the wait: BUSY, no broker contact, no stop", busy)
    r = run([T(2026, 11, 5, 8, 30), T(2026, 11, 5, 8, 31)])
    check(r == ("ran", 1, None), "…and the lock is free again once that process is gone", r)

# ── 7. the reconciler across a planned gap: 07:45 start → 08:30 login → the open, never a HALT ──
import manager.reconciler as rec  # noqa: E402
from lib import account_president as ap  # noqa: E402
ap._SNAPSHOT, ap.time = pw.OUT_PATH, FakeTime()
rec._current_venue = lambda: "president"
rec.get_positions = lambda: ap.get_positions({})
rec._read_env = lambda: {}
rec._key_fp, rec._guard_due = rec._key_fingerprint({}), False
HALTS, ROUNDS = [], []
rec._halt = lambda reason, message=None, **k: HALTS.append(reason)


def _round_then_tick():
    rec._next_round()
    try:
        rec._get_positions_guarded(now=CLOCKS[0].timestamp())
        ROUNDS.append((f"{CLOCKS[0]:%H:%M}", "read"))
    except rec.ReadSkipped:
        ROUNDS.append((f"{CLOCKS[0]:%H:%M}", "skipped"))
    except Exception as x:  # noqa: BLE001 — a counted failure is what this guards against
        ROUNDS.append((f"{CLOCKS[0]:%H:%M}", f"failed {type(x).__name__}"))
    _tick()


pw._write_snapshot, pw._sleep_until_refresh = _real_write_snapshot, _round_then_tick
stale = {"ok": True, "equity": 5.0, "positions": [], "data_at": int(T(2026, 11, 4, 22, 0).timestamp())}
r = run(minutes(T(2026, 11, 5, 7, 45), T(2026, 11, 5, 9, 0)), disk=stale)
check(r == ("ran", 1, None) and not HALTS and all(v == "skipped" for k, v in ROUNDS if k < "08:30")
      and all(v == "read" for k, v in ROUNDS if k >= "08:30"),
      "07:45 start with a snapshot older than 05:00: every round skipped until 08:30, read from 08:30 on, no HALT",
      (r, HALTS, sorted(set(v for _, v in ROUNDS))))
HALTS[:], ROUNDS[:] = [], []
r = run(minutes(T(2026, 11, 5, 8, 30), T(2026, 11, 5, 8, 50)), logins=[TIMEOUT, OK])
check(r == ("ran", 2, None) and not HALTS and all(v == "skipped" for k, v in ROUNDS if k < "08:35")
      and all(v == "read" for k, v in ROUNDS if k >= "08:35"),
      "08:30 TIMEOUT: rounds skipped while the retry waits, the 08:35 retry reads, no HALT", (r, HALTS, ROUNDS[:7]))
HALTS[:], ROUNDS[:] = [], []
os.remove(pw.OUT_PATH)
CLOCKS[:] = [T(2026, 11, 5, 10, 0)]
_real_write_snapshot({"ok": False, "error": "president worker error: something"})
for _ in range(4):
    rec._next_round()
    try:
        rec._get_positions_guarded(now=CLOCKS[0].timestamp())
    except Exception:  # noqa: BLE001
        pass
check(HALTS and HALTS[0].startswith("3 consecutive"), "a real failed read (no `waiting`) still counts and HALTs on the third — only the planned gap is skipped",
      HALTS)

print("\ncheck_president_login_drop: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
