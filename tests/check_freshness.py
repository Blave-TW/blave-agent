"""Minimal check: lib/freshness.py — the bar-freshness judgement lib/runner.py's
BLAVE_EXPECTED_BAR gate and manager/wait_for_bar.py's probe path share.

  1. the four tz cases that used to live only in wait_for_bar (Taipei labels converted to UTC,
     naive taken as UTC, Type C straggler named)
  2. wait_for_bar._judge_fallback (for a lib/ without this module) agrees with judge() on all
     of them, and _check_freshness still returns the same triple
  3. parse_expected: ISO → naive UTC; tz-aware → converted; garbage / empty → None (gate off)
  4. feed_wait: FeedNotPublished → the four ISO fields; any other exception → None

Run: cd blave-agent && .venv/bin/python tests/check_freshness.py
"""
import importlib.util
import os
import sys
import types
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import pandas as pd

from lib.freshness import judge, naive_utc, parse_expected, feed_wait, Verdict

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

expected = wfb._expected_closed_bar_open("1h", datetime(2026, 9, 23, 5, 10))
check(expected == datetime(2026, 9, 23, 4, 0), f"expected bar {expected}")


def frame(last_taipei, n=5):
    idx = pd.date_range(end=pd.Timestamp(last_taipei, tz="Asia/Taipei"), periods=n, freq="1h")
    return pd.DataFrame({"Close": 1.0}, index=idx)


naive = pd.DataFrame({"Close": 1.0}, index=pd.date_range(end="2026-09-23 04:00", periods=5, freq="1h"))
a, b = frame("2026-09-23 12:00")["Close"], frame("2026-09-23 11:00")["Close"]
close = pd.concat({"2330": a, "2317": b}, axis=1)
never = close.copy()
never["9999"] = float("nan")

cases = {
    "Type A, last bar 11:00 Taipei (03:00 UTC): not ready":
        (frame("2026-09-23 11:00"), Verdict(datetime(2026, 9, 23, 3), False, None)),
    "Type A, the 12:00 Taipei bar landed: ready":
        (frame("2026-09-23 12:00"), Verdict(datetime(2026, 9, 23, 4), True, None)),
    "naive (UTC) index: ready":
        (naive, Verdict(datetime(2026, 9, 23, 4), True, None)),
    "Type C, one Taipei symbol an hour behind: not ready, straggler named":
        ((close, close.copy()), Verdict(datetime(2026, 9, 23, 3), False, "2317")),
    "Type C, a column with no data at all: not ready, that column named":
        ((never, never.copy()), Verdict(None, False, "9999")),
    "Type A, empty frame": (pd.DataFrame({"Close": []}, index=pd.DatetimeIndex([])), Verdict(None, False, None)),
}
for label, (data, want) in cases.items():
    got = judge(data, expected)
    check(got == want, f"judge: {label} (got {got})")
    fb = wfb._judge_fallback(data, expected)
    check(tuple(fb) == tuple(want), f"_judge_fallback agrees: {label} (got {fb})")
    via = wfb._check_freshness(types.SimpleNamespace(fetch_data=lambda h, d=data: d), expected)
    check(via == tuple(want), f"_check_freshness returns the same triple: {label}")

# ── parse_expected ────────────────────────────────────────────────────────────
check(parse_expected("2026-10-11T14:42:00") == datetime(2026, 10, 11, 14, 42), "parse_expected: naive ISO")
check(parse_expected(" 2026-10-11T14:42:00 ") == datetime(2026, 10, 11, 14, 42), "parse_expected: stripped")
check(parse_expected("2026-10-11T22:42:00+08:00") == datetime(2026, 10, 11, 14, 42),
      "parse_expected: tz-aware → naive UTC")
for bad in ("", None, "tomorrow", "2026-13-01T00:00", 1700000000):
    check(parse_expected(bad) is None, f"parse_expected({bad!r}) → None (gate stays off)")

# ── feed_wait ─────────────────────────────────────────────────────────────────
from lib.data import FeedNotPublished
TPE = "Asia/Taipei"
exc = FeedNotPublished("twfutures_institutional", pd.Timestamp("2026-09-23", tz=TPE),
                       pd.Timestamp("2026-09-23 20:00", tz=TPE), pd.Timestamp("2026-09-23 21:00", tz=TPE))
fw = feed_wait(exc)
check(fw == {"source": "twfutures_institutional", "need": "2026-09-22T16:00:00",
             "due_at": "2026-09-23T12:00:00", "last_bar": "2026-09-23T13:00:00"},
      f"feed_wait: four naive-UTC ISO fields ({fw})")
check(feed_wait(RuntimeError("feed down")) is None, "feed_wait: another exception → None")
check(naive_utc(pd.Timestamp("2026-09-23 12:00", tz=TPE)) == datetime(2026, 9, 23, 4), "naive_utc: Taipei → UTC")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
