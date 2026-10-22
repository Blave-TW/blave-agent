"""The Type A/C scheduler fires on the wall-clock minute, not 60 s after its own work
(command_listener._scheduler_loop / _scheduler_delay / _next_slot / _run_retry_cycle).

  D  _scheduler_delay lands on the next :phase in (0, 60]; _next_slot walks :05 (full cycle) →
     :20 → :35 (retries) → :05; BLAVE_SCHEDULER_PHASE parsing (off / 0–14 / anything else).
  A  the real _scheduler_loop on a fake clock, 3000 slots, each full cycle's own work taking
     0–50 s at random (2% over a minute): every timed full cycle starts exactly at :05, retries
     only at :20/:35, one full cycle per minute, no accumulated drift.
  W  wakes (a 下單設定 save) and startup: before :45 a full cycle runs at once; at :45 or later
     nothing runs until the :05 cycle (report jobs are still armed at startup); neither shifts
     the grid. A timer firing > 2 s late (sleep) skips its slot and re-aligns — but never two
     slots in a row. Timers that fire up to 30 ms
     early (Windows) still give exactly one full cycle a minute.
  O  BLAVE_SCHEDULER_PHASE=off: the old loop — wait 60 s after the work, no retries.
  L  late feed, through the REAL wait_for_bar._tick (stub strategy, fake clock), the real
     _run_scheduler_cycle / _run_retry_cycle / gate: a bar served at :07 every minute is computed
     every minute, exactly once, from the :20 retry; one bar at :40 among them loses only that
     bar, not the ones after it (pending_since stays from the earlier minute — the retry goes by
     the state file being written this minute, not by pending_since); no retry round → nothing
     computed (the audit's P1); :03 → no retry started; :22 → the :35 retry; a feed that stops
     gets alerted and is not retried after. _not_ready_this_minute case by case.
  K  K3 — "bar M-1 never computed as the latest": launch times come from the REAL gate (scaled
     1:100, its wall clock on the same scale): 5×1m through 2 slots, and 10×1m through 1 slot
     (the :45 release lets the tail through). wait_for_bar's real _expected_closed_bar_open
     judges the bar at launch, lib.data's real _drop_forming_bar picks the last bar at the
     tick's end (7.4 s, the bench's concurrent wall — worst case): judged == computed for every
     tick and every minute's bar computed. The old loop (wait 60 s after ~1.7 s of work) run
     through the same check does produce misses — so the check can tell them apart.

Needs pandas (lib.data). No subprocess, no network.

Run: cd blave-agent && .venv/bin/python tests/check_scheduler_alignment.py
"""
import importlib.util
import json
import os
import random
import shutil
import sys
import tempfile
import threading
import time as _time
import types
from datetime import datetime, timedelta, timezone

if importlib.util.find_spec("pandas") is None:
    sys.exit(f"ENVIRONMENT: pandas is not importable from {sys.executable} — this is not a test "
             f"failure. Run with blave-agent/.venv/bin/python.")
import pandas as pd  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="sched-align-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies"):
    os.makedirs(os.path.join(WS, d))
shutil.copy(os.path.join(ROOT, "manager", "wait_for_bar.py"), os.path.join(WS, "manager"))
os.environ.update({"BLAVE_AGENT_BASE": BASE, "BLAVE_AGENT_WORKSPACE": WS})
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.environ.pop("BLAVE_SCHEDULER_PHASE", None)
os.environ.pop("BLAVE_TICK_CONCURRENCY", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402
import tick_gate as tg  # noqa: E402

sys.path.insert(0, ROOT)
from lib.data import _drop_forming_bar  # noqa: E402

spec = importlib.util.spec_from_file_location("wfb_under_test", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

fails = 0
PHASE, MIN = cl.SCHEDULER_PHASE_SECONDS, cl.SCHEDULER_INTERVAL_SECONDS


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails += 1


def sec(t):
    return t % 60


def utc(t):
    return datetime.fromtimestamp(t, timezone.utc).replace(tzinfo=None)


# ── D ──────────────────────────────────────────────────────────────────────────────────────
T0 = 1792000000.0 - 1792000000.0 % 60   # a minute boundary
for off, want in ((0, PHASE), (PHASE - 0.5, 0.5), (PHASE, 60), (PHASE + 0.001, 59.999), (59.9, PHASE + 0.1)):
    got = cl._scheduler_delay(T0 + off)
    check(abs(got - want) < 1e-6, f"now = :{off:06.3f} → wait {got:.3f}s (want {want})")
check(all(0 < cl._scheduler_delay(T0 + i * 0.37) <= 60 for i in range(2000)), "delay always in (0, 60]")
walk, t = [], T0 + 1
for _ in range(7):
    t, full = cl._next_slot(t)
    walk.append((round(t - T0), full))
check(walk == [(5, True), (20, False), (35, False), (65, True), (80, False), (95, False), (125, True)],
      f"slots: :05 full → :20 → :35 retries → next :05 ({walk})")
for env, want in (("off", None), ("OFF", None), ("8", 8), ("0", 0), ("14", 14), ("15", PHASE), ("x", PHASE), ("", PHASE)):
    os.environ["BLAVE_SCHEDULER_PHASE"] = env
    check(cl._scheduler_phase() == want, f"BLAVE_SCHEDULER_PHASE={env!r} → {want}")
os.environ.pop("BLAVE_SCHEDULER_PHASE", None)


# ── loop harness ───────────────────────────────────────────────────────────────────────────
class Stop(BaseException):
    pass


def drive(rounds, work=lambda r: 0.5, retry_work=lambda r: 0.1, wake_p=0.0, early_ms=0.0, seed=1,
          start=T0 + 17.3, real_cycle=False, join_ticks=False, late_every=0, late_s=0.0, reports=None):
    """Run the real _scheduler_loop on a fake clock → [(kind, start, woken)] kind 'full'|'retry'."""
    rng = random.Random(seed)
    clock = [start]
    waits = [0]
    runs, woke = [], [False]

    def full():
        runs.append(("full", clock[0], woke[0]))
        if real_cycle:
            saved_full()
        clock[0] += work(rng)

    def retry():
        runs.append(("retry", clock[0], woke[0]))
        if real_cycle:
            saved_retry()
        clock[0] += retry_work(rng)

    class Wake:
        def wait(self, timeout):
            if join_ticks:
                for th in threading.enumerate():
                    if th.name.startswith("strategy-tick-"):
                        th.join(10)
            if len(runs) >= rounds:
                raise Stop()
            if rng.random() < wake_p:
                clock[0] += rng.uniform(0, timeout)
                woke[0] = True
            else:
                clock[0] += max(0.0, timeout - (rng.uniform(0, early_ms) / 1000 if early_ms else 0))
                waits[0] += 1
                if late_every and waits[0] % late_every == 0:
                    clock[0] += late_s   # the machine slept through the timer
                woke[0] = False
            return woke[0]

        def clear(self):
            pass

    names = ("_sweep_legacy_report_schedules", "_downtime_check", "_downtime_watch_loop",
             "_downtime_pending", "_run_scheduler_cycle", "_run_retry_cycle", "_fire_due_reports",
             "_scheduler_wake", "time")
    saved = {k: getattr(cl, k) for k in names}
    saved_full, saved_retry = saved["_run_scheduler_cycle"], saved["_run_retry_cycle"]
    cl._sweep_legacy_report_schedules = cl._downtime_watch_loop = lambda: None
    cl._fire_due_reports = (lambda: reports.append((clock[0], len(runs)))) if reports is not None else (lambda: None)
    cl._downtime_check = lambda now=None: None
    cl._downtime_pending = lambda: False
    cl._run_scheduler_cycle, cl._run_retry_cycle = full, retry
    cl._scheduler_wake = Wake()
    cl.time = types.SimpleNamespace(time=lambda: clock[0])
    try:
        cl._scheduler_loop()
    except Stop:
        pass
    finally:
        for k, v in saved.items():
            setattr(cl, k, v)
    return runs


def phase_err(t, phase=PHASE):
    return abs(((t - phase) + 30) % 60 - 30)


# ── A ──────────────────────────────────────────────────────────────────────────────────────
runs = drive(3000, work=lambda r: r.uniform(0, 50) if r.random() > 0.02 else r.uniform(60, 130))
fulls = [t for k, t, w in runs[1:] if k == "full"]
retries = [t for k, t, w in runs if k == "retry"]
check(max(phase_err(t) for t in fulls) < 1e-6,
      f"{len(runs)} slots, work 0–50 s (2% over a minute): every full cycle at :{PHASE:02d}")
check(retries and all(min(abs(sec(t) - (PHASE + o)) for o in cl.SCHEDULER_RETRY_OFFSETS) < 1e-6 for t in retries),
      f"retry rounds only at :20 / :35 ({len(retries)})")
mins = [int((t - PHASE) // 60) for t in fulls]
check(len(set(mins)) == len(mins), "never two full cycles in one minute")
check(phase_err(fulls[0]) < 1e-6 and phase_err(fulls[-1]) < 1e-6, "no accumulated drift: first and last full cycle both on :05")

# ── W ──────────────────────────────────────────────────────────────────────────────────────
runs = drive(3000, wake_p=0.1, seed=7)
woken = [(k, t) for k, t, w in runs if w]
check(woken and all(k == "full" and sec(t) < cl.LATE_LAUNCH_SECOND for k, t in woken),
      f"a wake runs a full cycle at once only before :{cl.LATE_LAUNCH_SECOND} ({len(woken)} woken cycles)")
timed_full = [t for k, t, w in runs[1:] if k == "full" and not w]
check(max(phase_err(t) for t in timed_full) < 1e-6 and len({int((t - PHASE) // 60) for t in timed_full}) == len(timed_full),
      "wakes never shift the grid: timed full cycles still one per minute at :05")
late = [t for k, t, w in drive(400, wake_p=1.0, seed=9) if sec(t) >= cl.LATE_LAUNCH_SECOND]
check(not late, "with a wake every slot, nothing ever starts at :45 or later")

runs = drive(3000, early_ms=30, seed=11)
fulls = [t for k, t, w in runs[1:] if k == "full"]
per_min = {}
for t in fulls:
    per_min[round((t - PHASE) / 60)] = per_min.get(round((t - PHASE) / 60), 0) + 1
check(max(per_min.values()) == 1,
      f"timers firing up to 30 ms early: one full cycle per minute ({len(fulls)} cycles, max per minute {max(per_min.values())})")
check(max(phase_err(t) for t in fulls) < 0.031, "…each within 30 ms of :05 (the error does not accumulate)")

runs = drive(20, start=T0 + 50)
check(runs[0][0] == "retry" and [r for r in runs if r[0] == "full"][0][1] == T0 + 60 + PHASE,
      "process started at :50: no cycle before the next :05 (startup is a late wake too)")
check(drive(5, start=T0 + 17)[0][:2] == ("full", T0 + 17), "process started at :17: the first cycle runs at once")
reps = []
drive(5, start=T0 + 50, reports=reps)
check(reps and reps[0] == (T0 + 50, 0),
      "process started at :50: report jobs are armed at :50, before any cycle (a job due at :00 is not skipped)")

runs = drive(2000, late_every=10, late_s=3 * 60 + 47, seed=13)
fulls = [(t, w) for k, t, w in runs[1:] if k == "full"]
check(all(phase_err(t) < 1e-6 for t, w in fulls if not w),
      f"timers that fire minutes late (sleep): no full cycle off the :05 grid ({len(fulls)} full cycles)")
runs = drive(300, late_every=1, late_s=2.5, seed=17)
check(len([r for r in runs if r[0] == "full"]) >= 300 // 3 // 2 - 1,
      "a thread late on every timer still ticks (a late slot is skipped at most once in a row)")

# ── O ──────────────────────────────────────────────────────────────────────────────────────
os.environ["BLAVE_SCHEDULER_PHASE"] = "off"
runs = drive(300, work=lambda r: 1.7)
os.environ.pop("BLAVE_SCHEDULER_PHASE", None)
gaps = [b[1] - a[1] for a, b in zip(runs, runs[1:])]
check(all(k == "full" for k, _, _ in runs) and all(abs(g - 61.7) < 1e-6 for g in gaps),
      "phase off: the old loop — every round a full cycle, 60 s after the work (1.7 s work → 61.7 s apart)")

# ── L ──────────────────────────────────────────────────────────────────────────────────────
# The REAL wait_for_bar._tick runs every tick, in this process, on the fake clock; the strategy is
# a stub whose fetch_data serves the bars that have "landed" by then. Only its subprocess run
# (_run_strategy_protected) and the alerts are replaced. State is written by wait_for_bar itself,
# so a change in what it writes (field, format, when) is tested here, not modelled.
cl._ac_migration_done = True   # never touch this computer's crontab
cl._sync_deployment_registry = cl._prune_deployment_registry = lambda names: None
cl._signals_frozen = lambda: False
os.makedirs(os.path.join(WS, "strategies", "late1m"))
with open(os.path.join(WS, "strategies", "late1m", "strategy.py"), "w") as f:
    f.write('INTERVAL = "1m"\nSYMBOL = "BTCUSDT"\n\n\ndef fetch_data(headers):\n'
            '    import sys\n    return sys.modules["sched_align_feed"].frame()\n')
json.dump({"amounts": {"late1m": 100}}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
STATE = os.path.join(WS, "state", "bar_wait", "late1m.json")
os.chdir(WS)   # wait_for_bar works in workspace-relative paths


def fake_now():
    return cl.time.time()


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        d = datetime.fromtimestamp(fake_now(), timezone.utc)
        return d if tz else d.replace(tzinfo=None)


feed = types.ModuleType("sched_align_feed")
sys.modules["sched_align_feed"] = feed


def late_feed(delay_of, retries=True, rounds=360, stop_after=None):
    """delay_of(bar_open_datetime) → seconds after the bar closes that it is served (None = never).
    → (wanted minutes, computed bar labels, tick times, stall alerts, runs)."""
    for f in os.listdir(os.path.dirname(STATE)) if os.path.isdir(os.path.dirname(STATE)) else []:
        os.remove(os.path.join(os.path.dirname(STATE), f))
    ticks, computed, stalls = [], [], []
    origin = utc(T0) - timedelta(minutes=200)

    def frame():
        now = fake_now()
        n = int((utc(now) - origin).total_seconds() // 60) + 2
        idx = [origin + timedelta(minutes=i) for i in range(n)]
        served = []
        for b in idx:
            d = delay_of(b)
            close = (b - datetime(1970, 1, 1)).total_seconds() + 60
            if d is None or close + d > now:
                break
            served.append(b)
        return pd.DataFrame({"close": 1.0}, index=pd.DatetimeIndex(served))

    feed.frame = frame

    def run_protected(name):
        computed.append(feed.frame().index[-1].to_pydatetime())
        return True

    real_save = wfb._save_state

    def save(name, state):
        real_save(name, state)
        os.utime(f"{wfb.STATE_DIR}/{name}.json", (fake_now(), fake_now()))   # mtime on the fake clock

    patches = {"datetime": FakeDT, "time": types.SimpleNamespace(time=fake_now, monotonic=_time.monotonic, sleep=_time.sleep),
               "_run_strategy_protected": run_protected, "_save_state": save,
               "_alert_stale": lambda *a, **k: stalls.append(fake_now()),
               "_alert_failure": lambda: types.SimpleNamespace(alert=lambda *a, **k: None)}
    saved_w = {k: getattr(wfb, k) for k in patches}
    for k, v in patches.items():
        setattr(wfb, k, v)

    def tick(name):
        ticks.append(fake_now())
        wfb._tick(name)

    real_tick, real_retry = cl._tick_one, cl._run_retry_cycle
    cl._tick_one = tick
    cl._tick_gate, cl._tick_gate_read = tg.TickGate(2), True
    if not retries:
        cl._run_retry_cycle = lambda: None
    try:
        runs = drive(rounds, start=T0 + 1, real_cycle=True, join_ticks=True)   # startup at :01, bar not in yet
    finally:
        cl._tick_one, cl._run_retry_cycle = real_tick, real_retry
        for k, v in saved_w.items():
            setattr(wfb, k, v)
    first = utc(runs[1][1]).replace(second=0) - timedelta(minutes=1)
    last = utc(runs[-1][1]).replace(second=0) - timedelta(minutes=2)
    want = {first + timedelta(minutes=i) for i in range(int((last - first).total_seconds() // 60) + 1)}
    if stop_after is not None:
        want = {w for w in want if w < stop_after}
    return want, computed, ticks, stalls, runs


def fulls_of(runs):
    return len([r for r in runs if r[0] == "full"])


want, computed, ticks, stalls, runs = late_feed(lambda b: 7)
check(want <= set(computed) and len(computed) == len(set(computed)),
      f"real wait_for_bar, bar served at :07 every minute: all {len(want)} bars computed, none twice")
check(len(ticks) <= 2 * fulls_of(runs) + 2 and not stalls,
      f"…one :05 tick plus one :20 retry a minute ({len(ticks)} ticks over {fulls_of(runs)} minutes), no stall alert")

BLIP = utc(T0) + timedelta(minutes=30)
want, computed, ticks, stalls, runs = late_feed(lambda b: 40 if b == BLIP else 7)
missing = sorted(want - set(computed))
check(missing == [BLIP] and len(computed) == len(set(computed)) and not stalls,
      f"one bar at :40, the rest at :07: only that bar is lost, every bar after it computed "
      f"(missing {[m.strftime('%H:%M') for m in missing]}, {len(computed)} computed)")

want, computed, ticks, stalls, runs = late_feed(lambda b: 7, retries=False)
check(not computed, f"bar at :07, no retry round: {len(computed)} bars computed — the strategy stops (audit P1)")

want, computed, ticks, stalls, runs = late_feed(lambda b: 3)
check(want <= set(computed) and len(ticks) <= fulls_of(runs) + 1,
      f"bar at :03: every bar at :05, no retry started ({len(ticks)} ticks over {fulls_of(runs)} minutes)")
want, computed, ticks, stalls, runs = late_feed(lambda b: 22)
check(want <= set(computed), "bar at :22: computed at the :35 retry")

STOP = utc(T0) + timedelta(minutes=20)
want, computed, ticks, stalls, runs = late_feed(lambda b: 7 if b < STOP else None, stop_after=STOP)
after = [t for t in ticks if utc(t) > STOP + timedelta(minutes=30)]
check(want <= set(computed) and stalls, f"feed stops: bars before it computed, stall alerted ({len(stalls)} alert(s))")
check(all(sec(t) < PHASE + 1 for t in after),
      f"…once alerted, no more retries: {len(after)} ticks in the last minutes, all at :05")

# _not_ready_this_minute on its own
now = T0 + 25


def state_file(doc, mtime):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(doc, open(STATE, "w"))
    os.utime(STATE, (mtime, mtime))


for doc, mt, want_retry, why in (
        ({"pending_since": utc(T0 + 5).isoformat(), "stall_alert_at": None}, T0 + 5, True, "ticked at :05 this minute, not ready"),
        ({"pending_since": utc(T0 - 300).isoformat(), "stall_alert_at": None}, T0 + 5, True,
         "waiting since 5 minutes ago (one bar missed), ticked not-ready this minute"),
        ({"pending_since": utc(T0 - 300).isoformat(), "stall_alert_at": None}, T0 - 55, False, "last written last minute"),
        ({"pending_since": utc(T0 + 5).isoformat(), "stall_alert_at": 123.0}, T0 + 5, False, "stall already alerted"),
        ({"pending_since": None, "stall_alert_at": None}, T0 + 5, False, "computed (pending cleared)"),
        ({"pending_since": utc(T0 + 3600).isoformat(), "stall_alert_at": None}, T0 + 5, False, "feed row due in an hour"),
        ({"pending_since": T0 + 5.0, "stall_alert_at": None}, T0 + 5, True, "pending_since not an ISO string")):
    state_file(doc, mt)
    check(cl._not_ready_this_minute("late1m", now) is want_retry, f"retry? {why} → {want_retry}")
check(cl._not_ready_this_minute("no_such", now) is False, "retry? no state file → False")


# ── K ──────────────────────────────────────────────────────────────────────────────────────
WALL, SCALE = 7.4, 100.0


def gate_offsets(n, slots, interval_min=1):
    """Launch offsets (s after the :05 cycle) of n ticks through the real gate, time scaled 1:100;
    the gate's wall clock runs on the same scale, so the scheduler's :45 release is :45."""
    t0 = _time.monotonic()
    cycle_wall = T0 + PHASE

    def scaled():
        return (_time.monotonic() - t0) * SCALE

    gate = tg.TickGate(slots, clock=scaled, wall=lambda: cycle_wall + scaled(),
                       poll=tg.POLL_SECONDS / SCALE)   # 0.2 s real, on the test's scale
    starts, lk = {}, threading.Lock()

    def body(name):
        def fn():
            with lk:
                starts[name] = scaled()
            _time.sleep(WALL / SCALE)
        return fn

    release = T0 + cl.LATE_LAUNCH_SECOND if interval_min < 5 else None
    names = gate.enqueue([(f"k{i}", interval_min) for i in range(n)])
    ths = [threading.Thread(target=gate.run, args=(nm, body(nm)), kwargs={"release_at": release}) for nm in names]
    for th in ths:
        th.start()
    for th in ths:
        th.join(20)
    return sorted(starts.values())


def k3_check(cycle_starts, launch_offsets, fetch_at):
    """→ (mismatches, minutes never computed) over the cycles, using the real bar functions."""
    first = utc(cycle_starts[0]).replace(second=0, microsecond=0) - timedelta(minutes=5)
    last = utc(cycle_starts[-1]).replace(second=0, microsecond=0) + timedelta(minutes=5)
    bars = pd.DataFrame({"close": 1.0}, index=pd.date_range(first, last, freq="1min"))
    mism, computed = 0, set()
    for s in cycle_starts:
        for off in launch_offsets:
            judged = wfb._expected_closed_bar_open("1m", utc(s + off))
            seen = _drop_forming_bar(bars, "1m", now=pd.Timestamp(s + off + fetch_at, unit="s"), force=True)
            got = seen.index[-1].to_pydatetime()
            mism += got != judged
            computed.add(got)
    lo = utc(cycle_starts[1]).replace(second=0, microsecond=0)
    hi = utc(cycle_starts[-1]).replace(second=0, microsecond=0) - timedelta(minutes=2)
    want = {lo + timedelta(minutes=i) for i in range(int((hi - lo).total_seconds() // 60) + 1)}
    return mism, len(want - computed)


new = [t for k, t, w in drive(4500, retry_work=lambda r: 0.0, seed=3)[1:] if k == "full"]   # [0]: startup
for n, slots in ((5, 2), (10, 1)):
    offs = gate_offsets(n, slots)
    last = PHASE + max(offs)
    check(len(offs) == n and last <= cl.LATE_LAUNCH_SECOND + 2,
          f"{n}×1m, {slots} slot(s), {WALL}s each, real gate: last launch at :{last:04.1f} (≤ :{cl.LATE_LAUNCH_SECOND} + jitter)")
    m, never = k3_check(new, offs, WALL)
    check(m == 0 and never == 0,
          f"…{len(new)} aligned cycles: {m} bars judged ≠ computed, {never} minutes never computed")
offs = gate_offsets(10, 1, interval_min=60)
check(PHASE + max(offs) > cl.LATE_LAUNCH_SECOND + 10,
      f"10×1h through 1 slot is not released at :45 (last launch :{PHASE + max(offs):04.1f}) — the release is what keeps 1m in its minute")

os.environ["BLAVE_SCHEDULER_PHASE"] = "off"   # the old loop: wait(timeout=60) after the cycle's work
old = [t for k, t, w in drive(1500, work=lambda r: 1.7, seed=3)]
os.environ.pop("BLAVE_SCHEDULER_PHASE", None)
m_old, never_old = k3_check(old, [0.0], 6.3)   # one strategy, the 10-22 run's median 6.3 s tick
check(m_old > 0 and never_old > 0,
      f"old loop, same check: {m_old} judged ≠ computed and {never_old} minutes never computed "
      f"of 1500 (the check catches K3)")

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
