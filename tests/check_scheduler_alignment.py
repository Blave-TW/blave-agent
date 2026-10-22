"""The Type A/C scheduler fires on the wall-clock minute, not 60 s after its own work
(command_listener._scheduler_loop / _scheduler_delay).

  D  _scheduler_delay(now) lands on the next :SCHEDULER_PHASE_SECONDS, always in (0, 60].
  A  the real _scheduler_loop on a fake clock, 3000 rounds, each cycle's own work taking 0–50 s
     at random (sometimes > 60 s), plus random early wakes (a 下單設定 save): every cycle after
     an un-woken wait starts exactly at :05; no minute is skipped unless a cycle's own work ran
     through it; the error after 3000 rounds is the same as after 1 (no accumulation).
  K  K3 — "bar M-1 never computed as the latest": per cycle, wait_for_bar's real
     _expected_closed_bar_open judges the bar when the tick starts and lib.data's real
     _drop_forming_bar picks the strategy's last bar when it fetches. Five 1m strategies through
     the default 2-slot gate at the bench's concurrent tick wall (7.4 s; fetch at the end of the
     tick, worst case): every bar is judged and computed as the same bar, and every minute's bar
     is computed. The old loop (wait 60 s after ~1.7 s of work, the 10-22 run's drift) run
     through the same check does produce K3 misses — so the check can tell them apart.

Needs pandas (lib.data). No subprocess, no network.

Run: cd blave-agent && .venv/bin/python tests/check_scheduler_alignment.py
"""
import importlib.util
import os
import random
import shutil
import sys
import tempfile
import types
from datetime import datetime, timedelta

if importlib.util.find_spec("pandas") is None:
    sys.exit(f"ENVIRONMENT: pandas is not importable from {sys.executable} — this is not a test "
             f"failure. Run with blave-agent/.venv/bin/python.")
import pandas as pd  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="sched-align-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state"):
    os.makedirs(os.path.join(WS, d))
os.environ.update({"BLAVE_AGENT_BASE": BASE, "BLAVE_AGENT_WORKSPACE": WS})
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402

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


# ── D ──────────────────────────────────────────────────────────────────────────────────────
T0 = 1792000000.0 - 1792000000.0 % 60   # a minute boundary
for off, want in ((0, PHASE), (PHASE - 0.5, 0.5), (PHASE, 60), (PHASE + 0.001, 59.999), (59.9, PHASE + 0.1)):
    got = cl._scheduler_delay(T0 + off)
    check(abs(got - want) < 1e-6, f"now = :{off:06.3f} → wait {got:.3f}s (want {want})")
check(all(0 < cl._scheduler_delay(T0 + i * 0.37) <= 60 for i in range(2000)), "delay always in (0, 60]")


# ── A ──────────────────────────────────────────────────────────────────────────────────────
class Stop(BaseException):
    pass


def drive(rounds, work, early_wake_p=0.0, seed=1):
    """Run the real _scheduler_loop on a fake clock; returns [(cycle_start, woken_early_before)]."""
    rng = random.Random(seed)
    clock = [T0 + 17.3]   # starts mid-minute, like a fresh process
    starts, woke = [], [False]

    def cycle():
        starts.append((clock[0], woke[0]))
        clock[0] += work(rng)

    class Wake:
        def wait(self, timeout):
            if len(starts) >= rounds:
                raise Stop()
            if rng.random() < early_wake_p:
                clock[0] += rng.uniform(0, timeout)
                woke[0] = True
            else:
                clock[0] += timeout
                woke[0] = False
            return woke[0]

        def clear(self):
            pass

    saved = {k: getattr(cl, k) for k in ("_sweep_legacy_report_schedules", "_downtime_check",
                                         "_downtime_watch_loop", "_downtime_pending",
                                         "_run_scheduler_cycle", "_fire_due_reports",
                                         "_scheduler_wake", "time")}
    cl._sweep_legacy_report_schedules = cl._downtime_watch_loop = cl._fire_due_reports = lambda: None
    cl._downtime_check = lambda now=None: None
    cl._downtime_pending = lambda: False
    cl._run_scheduler_cycle = cycle
    cl._scheduler_wake = Wake()
    cl.time = types.SimpleNamespace(time=lambda: clock[0])
    try:
        cl._scheduler_loop()
    except Stop:
        pass
    finally:
        for k, v in saved.items():
            setattr(cl, k, v)
    return starts


def phase_err(t):
    return abs(((t - PHASE) + 30) % 60 - 30)


starts = drive(3000, lambda r: r.uniform(0, 50) if r.random() > 0.02 else r.uniform(60, 130))
on_grid = [t for t, early in starts[1:] if not early]
check(len(starts) == 3000 and max(phase_err(t) for t in on_grid) < 1e-6,
      f"3000 cycles, work 0–50 s (2% over a minute): every timed cycle starts at :{PHASE:02d} "
      f"(max error {max(phase_err(t) for t in on_grid):.2e}s)")
mins = [int((t - PHASE) // 60) for t, _ in starts[1:]]
gaps = [b - a for a, b in zip(mins, mins[1:])]
check(min(gaps) >= 1, "never two timed cycles in the same minute")
skipped = sum(g - 1 for g in gaps)
overrun = sum(1 for (t, _), (t2, _) in zip(starts[1:], starts[2:]) if t2 - t > 60 + 1e-6)
check(skipped > 0 and all(g == 1 or (t2 - t) > 60 for g, ((t, _), (t2, _)) in zip(gaps, zip(starts[1:], starts[2:]))),
      f"a minute is skipped only when that cycle's own work ran past it ({skipped} skipped, {overrun} overruns)")
check(phase_err(starts[1][0]) < 1e-6 and phase_err(starts[-1][0]) < 1e-6, "no accumulated drift: round 2 and round 3000 both on :05")

starts = drive(3000, lambda r: r.uniform(0.5, 3), early_wake_p=0.1, seed=7)
timed = [t for t, early in starts[1:] if not early]
check(timed and max(phase_err(t) for t in timed) < 1e-6,
      f"with 10% early wakes: every non-woken cycle still on :{PHASE:02d} ({len(timed)} of {len(starts)})")
check(len({int((t - PHASE) // 60) for t in timed}) == len(timed),
      "early wakes add cycles but never shift the grid (one timed cycle per minute)")


# ── K ──────────────────────────────────────────────────────────────────────────────────────
N, SLOTS, WALL = 5, 2, 7.4
assert SLOTS == cl.tick_gate.default_limit(1950, 2)


def k3_check(cycle_starts, launch_offsets, fetch_at):
    """→ (mismatches, minutes never computed) over the cycles, using the real bar functions."""
    first = datetime.utcfromtimestamp(cycle_starts[0]).replace(second=0, microsecond=0) - timedelta(minutes=5)
    last = datetime.utcfromtimestamp(cycle_starts[-1]).replace(second=0, microsecond=0) + timedelta(minutes=5)
    bars = pd.DataFrame({"close": 1.0}, index=pd.date_range(first, last, freq="1min"))
    mism, computed = 0, set()
    for s in cycle_starts:
        for off in launch_offsets:
            judged = wfb._expected_closed_bar_open("1m", datetime.utcfromtimestamp(s + off))
            seen = _drop_forming_bar(bars, "1m", now=pd.Timestamp(s + off + fetch_at, unit="s"), force=True)
            got = seen.index[-1].to_pydatetime()
            mism += got != judged
            computed.add(got)
    lo = datetime.utcfromtimestamp(cycle_starts[1]).replace(second=0, microsecond=0)
    hi = datetime.utcfromtimestamp(cycle_starts[-1]).replace(second=0, microsecond=0) - timedelta(minutes=2)
    want = {lo + timedelta(minutes=i) for i in range(int((hi - lo).total_seconds() // 60) + 1)}
    return mism, len(want - computed)


offsets = [(i // SLOTS) * WALL for i in range(N)]   # the 2-slot queue: 0, 0, 7.4, 7.4, 14.8
new = [t for t, _ in drive(1500, lambda r: r.uniform(0.5, 3), seed=3)]
m, never = k3_check(new, offsets, WALL)
check(m == 0 and never == 0,
      f"aligned loop, 5×1m through 2 slots at {WALL}s each: 1500 cycles, {m} bars judged ≠ computed, "
      f"{never} minutes never computed")

saved = cl._scheduler_delay
cl._scheduler_delay = lambda now: 60   # the old loop: wait(timeout=60) after the cycle's work
try:
    old = [t for t, _ in drive(1500, lambda r: 1.7, seed=3)]
finally:
    cl._scheduler_delay = saved
m_old, never_old = k3_check(old, [0.0], 6.3)   # one strategy, the 10-22 run's median 6.3 s tick
check(m_old > 0 and never_old > 0,
      f"old loop, same check: {m_old} judged ≠ computed and {never_old} minutes never computed "
      f"of 1500 (the check catches K3)")

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
