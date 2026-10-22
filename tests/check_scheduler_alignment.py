"""The Type A/C scheduler fires on the wall-clock minute, not 60 s after its own work
(command_listener._scheduler_loop / _scheduler_delay / _next_slot / _run_retry_cycle).

  D  _scheduler_delay lands on the next :phase in (0, 60]; _next_slot walks :05 (full cycle) →
     :20 → :35 (retries) → :05; BLAVE_SCHEDULER_PHASE parsing (off / 0–14 / anything else).
  A  the real _scheduler_loop on a fake clock, 3000 slots, each full cycle's own work taking
     0–50 s at random (2% over a minute): every timed full cycle starts exactly at :05, retries
     only at :20/:35, one full cycle per minute, no accumulated drift.
  W  wakes (a 下單設定 save) and startup: before :45 a full cycle runs at once; at :45 or later
     nothing runs until the :05 cycle; neither shifts the grid. Timers that fire up to 30 ms
     early (Windows) still give exactly one full cycle a minute.
  O  BLAVE_SCHEDULER_PHASE=off: the old loop — wait 60 s after the work, no retries.
  L  late feed — the 1m bar always lands at :07, i.e. after the :05 tick: the real
     _run_scheduler_cycle / _run_retry_cycle / gate with a model of wait_for_bar's state file
     (pending_since / last_processed_bar) compute every bar exactly once, from the :20 retry.
     Without the retry the same strategy computes nothing (the audit's P1); a bar landing at :03
     needs no retry and gets none; a wait that began in an earlier minute (a stall) or with a
     stall already alerted is not retried. The state-file fields it reads are pinned in
     wait_for_bar.py's own source.
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
          start=T0 + 17.3, real_cycle=False, join_ticks=False):
    """Run the real _scheduler_loop on a fake clock → [(kind, start, woken)] kind 'full'|'retry'."""
    rng = random.Random(seed)
    clock = [start]
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
                woke[0] = False
            return woke[0]

        def clear(self):
            pass

    names = ("_sweep_legacy_report_schedules", "_downtime_check", "_downtime_watch_loop",
             "_downtime_pending", "_run_scheduler_cycle", "_run_retry_cycle", "_fire_due_reports",
             "_scheduler_wake", "time")
    saved = {k: getattr(cl, k) for k in names}
    saved_full, saved_retry = saved["_run_scheduler_cycle"], saved["_run_retry_cycle"]
    cl._sweep_legacy_report_schedules = cl._downtime_watch_loop = cl._fire_due_reports = lambda: None
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

# ── O ──────────────────────────────────────────────────────────────────────────────────────
os.environ["BLAVE_SCHEDULER_PHASE"] = "off"
runs = drive(300, work=lambda r: 1.7)
os.environ.pop("BLAVE_SCHEDULER_PHASE", None)
gaps = [b[1] - a[1] for a, b in zip(runs, runs[1:])]
check(all(k == "full" for k, _, _ in runs) and all(abs(g - 61.7) < 1e-6 for g in gaps),
      "phase off: the old loop — every round a full cycle, 60 s after the work (1.7 s work → 61.7 s apart)")

# ── L ──────────────────────────────────────────────────────────────────────────────────────
cl._ac_migration_done = True   # never touch this computer's crontab
cl._sync_deployment_registry = cl._prune_deployment_registry = lambda names: None
cl._signals_frozen = lambda: False
os.makedirs(os.path.join(WS, "strategies", "late1m"))
with open(os.path.join(WS, "strategies", "late1m", "strategy.py"), "w") as f:
    f.write('INTERVAL = "1m"\n')
json.dump({"amounts": {"late1m": 100}}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
STATE = os.path.join(WS, "state", "bar_wait", "late1m.json")
os.makedirs(os.path.dirname(STATE))


def feed_model(delay, ticks, computed):
    """wait_for_bar as far as its state file goes: fast path, not-ready → pending_since, ready →
    computed, pending cleared. The bar opening at M is served at M + 60 + delay."""
    def tick(name):
        now = cl.time.time()
        ticks.append(now)
        try:
            st = json.load(open(STATE))
        except (OSError, ValueError):
            st = {"last_processed_bar": None, "pending_since": None, "stall_alert_at": None}
        expected = wfb._expected_closed_bar_open("1m", utc(now))
        if st["last_processed_bar"] == expected.isoformat():
            return
        if now >= (expected - datetime(1970, 1, 1)).total_seconds() + 60 + delay:
            computed.append(expected)
            st["last_processed_bar"], st["pending_since"] = expected.isoformat(), None
        elif st["pending_since"] is None:
            st["pending_since"] = utc(now).isoformat()
        json.dump(st, open(STATE, "w"))
    return tick


def late_feed(delay, retries=True, rounds=360):
    if os.path.exists(STATE):
        os.remove(STATE)
    ticks, computed = [], []
    real_tick, real_retry = cl._tick_one, cl._run_retry_cycle
    cl._tick_one = feed_model(delay, ticks, computed)
    cl._tick_gate, cl._tick_gate_read = tg.TickGate(2), True
    if not retries:
        cl._run_retry_cycle = lambda: None
    try:
        runs = drive(rounds, start=T0 + 1, real_cycle=True, join_ticks=True)   # startup cycle at :01, bar not in yet
    finally:
        cl._tick_one, cl._run_retry_cycle = real_tick, real_retry
    first = utc(runs[1][1]).replace(second=0) - timedelta(minutes=1)
    last = utc(runs[-1][1]).replace(second=0) - timedelta(minutes=2)
    want = {first + timedelta(minutes=i) for i in range(int((last - first).total_seconds() // 60) + 1)}
    return want, computed, ticks, runs


want, computed, ticks, runs = late_feed(7)
nmin = len([r for r in runs if r[0] == "full"])
check(want <= set(computed) and len(computed) == len(set(computed)),
      f"bar served at :07 every minute: all {len(want)} bars computed, none twice ({len(computed)} computed)")
check(len(ticks) <= 2 * nmin + 2, f"…one :05 tick plus one :20 retry a minute ({len(ticks)} ticks over {nmin} minutes)")
want, computed, ticks, runs = late_feed(7, retries=False)
check(not computed, f"same feed, no retry round: {len(computed)} bars computed — the strategy stops (audit P1)")
want, computed, ticks, runs = late_feed(3)
nmin = len([r for r in runs if r[0] == "full"])
check(want <= set(computed) and len(ticks) <= nmin + 1,
      f"bar served at :03: every bar at :05, no retry started ({len(ticks)} ticks over {nmin} minutes)")
want, computed, ticks, runs = late_feed(22)
check(want <= set(computed), "bar served at :22: computed at the :35 retry")

now = T0 + 25
for pend, alert, want_retry, why in ((utc(T0 + 5), None, True, "went not-ready at :05 this minute"),
                                     (utc(T0 - 55), None, False, "waiting since last minute (a stall)"),
                                     (utc(T0 + 5), 123.0, False, "stall already alerted"),
                                     (None, None, False, "not pending")):
    json.dump({"pending_since": pend.isoformat() if pend else None, "stall_alert_at": alert}, open(STATE, "w"))
    check(cl._not_ready_this_minute("late1m", now) is want_retry, f"retry? {why} → {want_retry}")
check(cl._not_ready_this_minute("no_such", now) is False, "retry? no state file → False")

# The retry reads wait_for_bar's state file: pin the fields it relies on in wait_for_bar itself, so a
# rename there turns this red instead of silently ending the retries.
wsrc = open(os.path.join(ROOT, "manager", "wait_for_bar.py"), encoding="utf-8").read()
for frag, why in (('STATE_DIR = "state/bar_wait"', "state lives in state/bar_wait/<name>.json"),
                  ("now = datetime.now(timezone.utc).replace(tzinfo=None)", "`now` is naive UTC"),
                  ('state["pending_since"] = now.isoformat()', "not-ready writes pending_since as an ISO string"),
                  ('state["pending_since"] = None', "a computed bar clears pending_since"),
                  ('state["stall_alert_at"] = time.time()', "a stall alert sets stall_alert_at")):
    check(frag in wsrc, f"wait_for_bar contract: {why}")


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
