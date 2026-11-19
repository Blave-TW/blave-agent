"""The reconciler's half of the hang watch (desktop 0.1.58, spec live-order-hang-wake-0158 §2).

- progress stamp: written once at startup with this pid, only when lib/execute and lib/portfolio
  are new enough (a half-updated workspace stays unwatched); touched around every order leg
  (place_order), every position read and every venue lookup, so a 10-leg round of 100 s legs
  never looks stalled to the watch (acceptance 6, 27a)
- the startup reap and the ONE notice for a hang kill (16–21, 10b): markers + self_ledger on →
  HALT + execution_interrupted(cause hang) only; otherwise reconciler_hang_restarted /
  reconciler_hang_halted; the kill record is always removed
- every order leg is marked (lib/portfolio "<symbol>#market"): gone after a fill, a raise or a
  skip; seen while the send is out; an unwritable marker holds an entry and lets a reduce go,
  with an audit row either way (11–14); a Windows remove retries a share violation (15)
- after request_stop no new leg is sent (26)

Run: cd blave-agent && .venv/bin/python tests/check_reconciler_hang.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="rec-hang-")
os.chdir(TMP)
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = TMP
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from lib import events, execute, guard, portfolio  # noqa: E402
from manager import reconciler as rec  # noqa: E402
import hang_watch  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


sent = []
events._appender = lambda t, p: sent.append((t, p))
execute._notify_fn = lambda m: None


def fresh(self_ledger=True):
    for d in ("state", "manager", "strategies"):
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs("manager")
    os.makedirs("state")
    json.dump({"self_ledger": self_ledger, "amounts": {}, "exchanges": {}},
              open("manager/portfolio_config.json", "w"))
    guard.release_memory_halt()
    del sent[:]


def record(age=60, halt=False, pid=None):
    os.makedirs("state/execution", exist_ok=True)
    json.dump({"pid": pid or os.getpid() + 1, "at": time.time() - age, "inflight": [], "halt": halt},
              open(rec.HANG_KILL_PATH, "w"))


def marker(key="BTCUSDT#market"):
    check(execute._write_inflight_marker(key, "market", 50), f"(setup) marker {key} written")
    execute._own_markers.discard(key)   # the previous process's, not ours


def halt_info():
    try:
        return json.load(open("state/HALT"))
    except OSError:
        return None


types_sent = lambda: [t for t, _ in sent]  # noqa: E731

# ── 16–21, 10b: the startup reap and the one notice ──────────────────────────────────────────
fresh(True); record(); marker()
out = rec._startup_reap()
h = halt_info()
check(out is None and types_sent() == ["execution_interrupted"] and sent[0][1].get("cause") == "hang",
      f"16 record + marker + self_ledger: only execution_interrupted(cause hang) ({sent})")
check(h is not None and h.get("source") == "execute", f"16 the reap tripped HALT, source execute ({h})")
check(execute.list_inflight() == [] and not rec.HANG_KILL_PATH.exists(), "16 marker and record both removed")

fresh(False); record(); marker()
out = rec._startup_reap()
check(out == "reconciler_hang_restarted" and types_sent() == ["reconciler_hang_restarted"]
      and halt_info() is None and execute.list_inflight() == [],
      f"17 marker, self_ledger off: no HALT, one reconciler_hang_restarted ({sent})")

fresh(True); record()
out = rec._startup_reap()
check(out == "reconciler_hang_restarted" and types_sent() == ["reconciler_hang_restarted"] and halt_info() is None,
      f"18 record, no marker: reconciles as usual, one reconciler_hang_restarted ({sent})")

fresh(True); marker()
out = rec._startup_reap()
check(out is None and types_sent() == ["execution_interrupted"] and "cause" not in sent[0][1]
      and (halt_info() or {}).get("source") == "execute",
      f"19 no record, marker: HALT, execution_interrupted without cause ({sent})")

fresh(True); guard.trip_halt(hang_watch.HALT_REASON, hang_watch.HALT_SOURCE); record(halt=True)
out = rec._startup_reap()
check(out == "reconciler_hang_halted" and types_sent() == ["reconciler_hang_halted"]
      and (halt_info() or {}).get("source") == "hang_watch",
      f"20 third hang (record halt): one reconciler_hang_halted, the watch's HALT kept ({sent})")

fresh(True); guard.trip_halt(hang_watch.HALT_REASON, hang_watch.HALT_SOURCE); record(halt=True); marker()
out = rec._startup_reap()
check(types_sent() == ["execution_interrupted"] and sent[0][1].get("cause") == "hang",
      f"21 third hang with a marker: only execution_interrupted(cause hang) ({sent})")

fresh(True); record(age=2 * 3600)
out = rec._startup_reap()
check(out is None and sent == [] and not rec.HANG_KILL_PATH.exists(),
      f"10b a 2 h old record (failed respawn): removed, nothing sent ({sent})")

fresh(True); record(pid=os.getpid())
out = rec._startup_reap()
check(out is None and sent == [], "a record naming this very pid is not a kill of a previous process")

# ── 27a: a half-updated workspace (old lib/execute) under the new reconciler.py ──────────────
fresh(True); record(); marker()
real_reap, real_active = execute.reap_dead_inflight, execute.sync_leg_active
execute.reap_dead_inflight = lambda: real_reap()   # an old signature: no cause
del execute.sync_leg_active
try:
    check(rec._progress_capable() is False, "27a old lib: not capable")
    rec._progress_init()
    check(not rec.PROGRESS_PATH.exists() and rec._progress_on is False, "27a old lib: no progress stamp written")
    rec._startup_reap()
    check(types_sent() == ["execution_interrupted"] and "cause" not in sent[0][1]
          and (halt_info() or {}).get("source") == "execute" and execute.list_inflight() == [],
          f"27a old reap (no cause): still reaps and HALTs ({sent})")
finally:
    execute.reap_dead_inflight, execute.sync_leg_active = real_reap, real_active
check(rec._progress_capable() is True, "new lib: capable")
real_wake = portfolio.set_wake_hold
del portfolio.set_wake_hold
check(rec._progress_capable() is False, "27a old lib/portfolio (no leg markers proof): not capable")
portfolio.set_wake_hold = real_wake

fresh(True)
rec._progress_init()
st = json.load(open(rec.PROGRESS_PATH))
check(set(st) == {"pid", "ppid", "at", "v"} and st["pid"] == os.getpid() and st["ppid"] == os.getppid()
      and abs(st["at"] - time.time()) < 60 and hang_watch.stamp(TMP)[:3:2] == (os.getpid(), os.getppid()),
      f"startup stamp = this pid, read the same by the watch ({st})")

# ── 10: HALT, machine-restart stop, no venue, update hold all `continue` after the loop-top touch ──
main = open(os.path.join(ROOT, "manager", "reconciler.py"), encoding="utf-8").read().split("    while True:\n", 1)[1]
top = main.index("_progress()")
check(all(top < main.index(g) for g in ("if _update_hold():", "if RESTART_STOP_PATH.exists():",
                                         "if not _venue_bound():", "reconcile(")),
      "10 the loop-top touch comes before every idle gate: an idle, halted or held reconciler stays fresh")

# ── 6: a long round whose legs keep moving is never stalled ───────────────────────────────────
clock = [time.time()]
real_utime = os.utime


def fake_utime(path, times=None, **kw):
    return real_utime(path, times if times is not None else (clock[0], clock[0]), **kw)


os.utime = fake_utime
w = hang_watch.Watch(TMP, clock=lambda: clock[0])
stalls = []


def slow_leg(symbol, signed_diff, **kw):
    for _ in range(4):           # the watch looks every 25 s during a 100 s leg
        clock[0] += 25
        stalls.append(w.stall(os.getpid()))
    return {"executed_qty": 1, "avg_price": 1.0}


real_dispatch = execute.dispatch_order
execute.dispatch_order = slow_leg
try:
    rec._progress()
    w.stall(os.getpid())
    t0 = clock[0]
    for i in range(10):
        rec.place_order(f"S{i}USDT", 100)
    check(clock[0] - t0 == 1000 and max(stalls) < hang_watch.HANG_STALL_S and len(stalls) == 40,
          f"6 ten 100 s legs (1000 s round): longest stall {max(stalls):.0f}s < {hang_watch.HANG_STALL_S}s")
    for _ in range(10):
        clock[0] += 25
        last = w.stall(os.getpid())
    check(last > hang_watch.HANG_STALL_S, f"6 (control) 250 s with no progress IS a stall ({last:.0f}s)")
finally:
    execute.dispatch_order = real_dispatch
    os.utime = real_utime

# ── 26: after request_stop no new leg goes ───────────────────────────────────────────────────
called = []
execute.dispatch_order = lambda *a, **k: called.append(a) or {"executed_qty": 1}
try:
    check(rec.place_order("BTCUSDT", 10) == {"executed_qty": 1} and len(called) == 1, "26 (control) a leg goes")
    execute.request_stop()
    check(rec.place_order("BTCUSDT", 10) is False and len(called) == 1, "26 stopping: the next leg is not sent")
finally:
    execute._stop_requested.clear()
    execute.dispatch_order = real_dispatch

# hand-wired legs (群益 / 統一 / 永豐) go through the same wrapper: progress around them too
seen = []
for venue in ("capital", "president"):
    real_impl = rec._HAND_WIRED[venue]
    real_has = rec.venue_traits.has
    rec._HAND_WIRED[venue] = (real_impl[0], lambda s, d, **k: seen.append(os.path.getmtime(rec.PROGRESS_PATH)) or {"x": 1})
    real_stop = (rec._president_login_stopped, rec._capital_login_stopped, rec._president_credentials_ready)
    rec._president_login_stopped = rec._capital_login_stopped = lambda: False
    rec._president_credentials_ready = lambda: True
    try:
        os.utime(rec.PROGRESS_PATH, (1000, 1000))
        out = rec.place_order("TXF", 1, exchange=venue)
        check(out == {"x": 1} and seen and seen[-1] > 1000 and os.path.getmtime(rec.PROGRESS_PATH) > 1000,
              f"12 {venue}: routed through the wrapper, stamp touched before and after the send")
    finally:
        rec._HAND_WIRED[venue] = real_impl
        rec._president_login_stopped, rec._capital_login_stopped, rec._president_credentials_ready = real_stop

# ── 11–14: every order leg is marked by reconcile ─────────────────────────────────────────────
H = 3600


def setup(target, held, exchange="paper"):
    fresh(True)
    os.makedirs("strategies/s")
    open("strategies/s/strategy.py", "w").write('INTERVAL = "1h"\n')
    json.dump(target, open("strategies/s/state.json", "w"))
    os.makedirs("state/bar_wait")
    json.dump({"last_processed_bar": None, "last_attempt_failed_at": None}, open("state/bar_wait/s.json", "w"))
    json.dump({"self_ledger": False, "amounts": {"s": 100}, "exchanges": {"s": exchange}},
              open("manager/portfolio_config.json", "w"))
    portfolio.drift_band = lambda symbol: portfolio._DRIFT_BAND_FLOOR
    return {k: {"side": "long" if v > 0 else "short", "size": abs(v)} for k, v in held.items() if v}


def marker_files():
    try:
        return sorted(n for n in os.listdir(execute._INFLIGHT_DIR) if n.endswith(".json"))
    except OSError:
        return []


LONG = {"symbol": "BTCUSDT", "position": 1}
FLAT = {"symbol": "BTCUSDT", "position": 0}
for how, fn in (("fill", lambda *a, **k: {"executed_qty": 1, "avg_price": 1.0}),
                ("raise", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("rejected"))),
                ("skip (async handed off)", lambda *a, **k: False)):
    held = setup(LONG, {})
    inflight_seen = []

    def place(symbol, signed_diff, asset_spec=None, reduce_only=False, _fn=fn):
        inflight_seen.append([m.get("key") for m in execute.list_inflight()])
        return _fn()
    portfolio.reconcile(lambda: held, place)
    check(inflight_seen == [["BTCUSDT#market"]] and marker_files() == [],
          f"11/12 {how}: marker seen during the send, gone after ({inflight_seen}, left {marker_files()})")

held = setup(LONG, {})
open(guard.RESTART_STOP_PATH, "w").write("{}")
portfolio.reconcile(lambda: held, rec.place_order)
check(marker_files() == [], "13 restart-stop gate in place_order: nothing sent, no marker left")
os.remove(guard.RESTART_STOP_PATH)

for target, have, intent, goes in ((LONG, {}, "entry", False), (FLAT, {"BTCUSDT": 100}, "reduce", True)):
    held = setup(target, have)
    os.makedirs("state/execution", exist_ok=True)
    open(execute._INFLIGHT_DIR, "w").close()   # a file where the marker directory goes: every write fails
    calls = []
    portfolio.reconcile(lambda: held, lambda s, d, a=None, reduce_only=False: calls.append((s, d)) or {"executed_qty": 1})
    audits = [json.loads(x) for x in open(guard.AUDIT_PATH).read().splitlines()]
    rows = [a for a in audits if a.get("event") == "sync_marker_unwritable"]
    check(bool(calls) == goes and len(rows) == 1 and rows[0].get("intent") == intent,
          f"14 marker unwritable, {intent}: {'sent' if goes else 'not sent'}, audit row ({calls}, {rows})")
    os.remove(execute._INFLIGHT_DIR)

# ── 15: a Windows share violation on remove is retried ───────────────────────────────────────
fresh(True)
execute._write_inflight_marker("ETHUSDT#market", "market", 5)
real_remove, tries = os.remove, []


def flaky_remove(p):
    tries.append(p)
    if len(tries) == 1:
        raise PermissionError(13, "sharing violation")
    return real_remove(p)


real_delays = getattr(execute._winreplace, "REPLACE_RETRY_DELAYS")
execute._winreplace.REPLACE_RETRY_DELAYS = (0.0, 0.0)
os.remove = flaky_remove
try:
    check(execute.sync_leg_active() is True, "15 (setup) our own leg marker counts as an active leg")
    execute._remove_inflight_marker("ETHUSDT#market")
finally:
    os.remove = real_remove
    execute._winreplace.REPLACE_RETRY_DELAYS = real_delays
check(len(tries) == 2 and marker_files() == [] and execute.sync_leg_active() is False,
      f"15 share violation: retried once, removed, leg no longer active ({len(tries)} tries)")

# ── S4: a marker left on purpose (or that cannot be removed) is not a leg in flight any more ────
fresh(True)
execute._write_inflight_marker("XRPUSDT#market", "market", 5)
check(execute.sync_leg_active() is True, "S4 (setup) a leg marker of ours is in flight")
execute.disown_inflight_marker("XRPUSDT#market")
check(execute.sync_leg_active() is False and marker_files() == ["XRPUSDT_market.json"],
      "S4 disowned: the exit path no longer waits on it, the marker stays for the next start's reap")
execute._write_inflight_marker("ADAUSDT#market", "market", 5)
real_remove = os.remove
os.remove = lambda p: (_ for _ in ()).throw(OSError(5, "I/O error"))
try:
    execute._remove_inflight_marker("ADAUSDT#market")
finally:
    os.remove = real_remove
check(execute.sync_leg_active() is False and "ADAUSDT_market.json" in marker_files(),
      "S4 a remove that keeps failing: the marker stays on disk, not counted as a leg in flight")
held = setup(LONG, {})
import lib.unconfirmed as _unc  # noqa: E402
real_park = portfolio.park_or_halt
portfolio.park_or_halt = lambda *a, **k: "halted"
try:
    portfolio.reconcile(lambda: held, lambda *a, **k: (_ for _ in ()).throw(_unc.OrderOutcomeUnknown("timeout")))
finally:
    portfolio.park_or_halt = real_park
check("BTCUSDT_market.json" in marker_files() and execute.sync_leg_active() is False,
      "S4 an outcome that could not be parked: the marker stays, the exit path does not wait on it")

# ── S5: the desktop SIGTERM handler runs on the main thread, maybe while it holds the marker lock ─
import threading as _th  # noqa: E402
done = []
with execute._own_markers_lock:
    t = _th.Thread(target=lambda: done.append(execute.sync_leg_active()))
    done.append(execute.sync_leg_active())   # same thread, lock held: an RLock lets it through
t.start()
t.join(5)
check(len(done) == 2, "S5 sync_leg_active() from inside a held marker lock (same thread) does not deadlock")

shutil.rmtree(TMP, ignore_errors=True)
print("PASS" if not fails else f"FAILED ({fails})")
sys.exit(1 if fails else 0)
