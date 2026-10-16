"""Minimal check: wait_for_bar's fallback copy of lib/bar_ready answers exactly as lib/bar_ready,
and wait_for_bar loads and ticks on it when the lib has no bar_ready (half-updated workspace).

Same inputs to both copies: every interval spelling, clocks on and off a bar boundary, Type A
frames (naive and Asia/Taipei), Type C frames (complete, a straggler, a column with no data,
empty), and members inside / past the priming grace.

Run: cd blave-agent && .venv/bin/python tests/check_bar_ready_fallback.py
"""
import contextlib
import importlib.abc
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.bar_ready as br

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def load_wfb(tag):
    spec = importlib.util.spec_from_file_location(f"wfb_{tag}", os.path.join(ROOT, "manager", "wait_for_bar.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


wfb = load_wfb("lib")
check(wfb._judge is br.judge and wfb.member_in_grace is br.member_in_grace,
      "with lib/bar_ready present, wait_for_bar uses it (the copy is only a fallback)")

# ── same answers ─────────────────────────────────────────────────────────────
INTERVALS = ["1m", "5min", "15m", "60m", "1h", "4h", "1d", "1w"]
NOWS = [datetime(2026, 10, 15, 9, 26), datetime(2026, 10, 16, 0, 0), datetime(2026, 10, 16, 0, 2),
        datetime(2024, 2, 29, 23, 59, 59)]
diff = [(iv, n) for iv in INTERVALS for n in NOWS
        if wfb._fb_expected_closed_bar_open(iv, n) != br.expected_closed_bar_open(iv, n)
        or wfb._fb_interval_to_timedelta(iv) != br.interval_to_timedelta(iv)]
check(not diff, f"interval and expected bar: identical for {len(INTERVALS)} intervals × {len(NOWS)} clocks {diff}")
bad = []
for f in (wfb._fb_interval_to_timedelta, br.interval_to_timedelta):
    try:
        f("1x")
        bad.append(f)
    except ValueError:
        pass
check(not bad, "an unknown interval raises ValueError in both")

idx = pd.date_range(end="2026-10-15", periods=10, freq="D")
tpe = pd.date_range(end="2026-10-15", periods=10, freq="D", tz="Asia/Taipei")
full = pd.DataFrame(np.arange(30.0).reshape(10, 3), index=idx, columns=["A", "B", "C"])
lag = full.copy(); lag.iloc[-1, 1] = np.nan
lag3 = full.copy(); lag3.iloc[-3:, 2] = np.nan
never = full.copy(); never["C"] = np.nan
CASES = {
    "A naive": pd.DataFrame({"Close": 1.0}, index=idx),
    "A taipei": pd.DataFrame({"Close": 1.0}, index=tpe),
    "A empty": pd.DataFrame({"Close": []}, index=pd.DatetimeIndex([])),
    "C complete": (full, full),
    "C straggler": (lag, lag),
    "C stuck 3 bars": (lag3, lag3),
    "C never": (never, never),
    "C empty": (full.iloc[:0], full.iloc[:0]),
    "C taipei": (full.set_axis(tpe), full.set_axis(tpe)),
}
for name, data in CASES.items():
    for exp in (datetime(2026, 10, 14), datetime(2026, 10, 15), datetime(2026, 10, 16)):
        a, b = wfb._fb_judge(data, exp), br.judge(data, exp)
        if a != b:
            bad.append((name, exp, a, b))
check(not bad, f"judge: identical on {len(CASES)} frames × 3 expected bars {bad[:2]}")

td = timedelta(days=1)
latest_sets = [{"A": datetime(2026, 10, 15), "B": datetime(2026, 10, 14)},
               {"A": datetime(2026, 10, 15), "B": datetime(2026, 10, 10)},
               {"": datetime(2026, 10, 15)}]
g = [(l, n) for l in latest_sets for n in [datetime(2026, 10, 16, 0, 2), datetime(2026, 10, 16, 0, 6), datetime(2026, 10, 17)]
     if wfb._fb_member_in_grace(l, datetime(2026, 10, 15), n, td) != br.member_in_grace(l, datetime(2026, 10, 15), n, td)]
check(not g and wfb._FB_PRIME_GRACE_SECONDS == br.PRIME_GRACE_SECONDS,
      f"priming grace: identical (inside, just past, long past) and the same grace seconds {g}")


# ── a lib without bar_ready: wait_for_bar loads on the copy and ticks ───────
class _NoBarReady(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name == "lib.bar_ready":
            raise ModuleNotFoundError("No module named 'lib.bar_ready'")
        return None


saved = sys.modules.pop("lib.bar_ready")
sys.meta_path.insert(0, _NoBarReady())
try:
    old = load_wfb("oldlib")
finally:
    sys.meta_path.pop(0)
    sys.modules["lib.bar_ready"] = saved
check(old._judge is old._fb_judge and old.member_in_grace is old._fb_member_in_grace
      and old.PRIME_GRACE_SECONDS == br.PRIME_GRACE_SECONDS,
      "lib without bar_ready: wait_for_bar loads and falls back to its own copy")

ws = tempfile.mkdtemp(prefix="bar-ready-fb-", dir=os.environ.get("SCRATCHPAD") or None)
os.chdir(ws)
os.makedirs("strategies/demo")
old._load_strategy_module = lambda n: types.SimpleNamespace(
    INTERVAL="1d", fetch_data=lambda h: (full.set_axis(pd.date_range(end="2026-10-16", periods=10, freq="D")),) * 2)
ran = []
old._run_strategy_protected = lambda n: ran.append(n) or True


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, 16, 9, 0, tzinfo=tz)


old.datetime = FakeDT
with contextlib.redirect_stdout(io.StringIO()):
    old._tick("demo")
st = json.load(open("state/bar_wait/demo.json"))
check(ran == ["demo"] and st.get("last_processed_bar") == "2026-10-15T00:00:00",
      f"…and a tick on the copy runs the strategy and records the bar ({ran}, {st.get('last_processed_bar')})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
