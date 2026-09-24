"""Minimal check: wait_for_bar's freshness probe converts tz-aware bars (Taiwan data is
Asia/Taipei) to UTC before comparing with the expected bar, instead of dropping the tz and
reading Taipei wall clock as UTC (8h early → "ready" before the bar has landed).

Run: cd blave-agent && .venv/bin/python tests/check_wait_for_bar_tz.py
"""
import importlib.util
import os
import sys
import types
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import pandas as pd

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)

# 2026-09-23 05:10 UTC = 13:10 Taipei → the expected 1h bar is the 04:00 UTC (12:00 Taipei) one
expected = wfb._expected_closed_bar_open("1h", datetime(2026, 9, 23, 5, 10))
check(expected == datetime(2026, 9, 23, 4, 0), f"expected bar {expected}")


def frame(last_taipei, n=5):
    idx = pd.date_range(end=pd.Timestamp(last_taipei, tz="Asia/Taipei"), periods=n, freq="1h")
    return pd.DataFrame({"Close": 1.0}, index=idx)


behind = types.SimpleNamespace(fetch_data=lambda h: frame("2026-09-23 11:00"))
seen, ready, _ = wfb._check_freshness(behind, expected)
check(not ready and seen == datetime(2026, 9, 23, 3, 0),
      f"Type A, last bar 11:00 Taipei (03:00 UTC): not ready, seen in UTC (got {seen}, ready={ready})")

landed = types.SimpleNamespace(fetch_data=lambda h: frame("2026-09-23 12:00"))
seen, ready, _ = wfb._check_freshness(landed, expected)
check(ready and seen == datetime(2026, 9, 23, 4, 0), f"Type A, the 12:00 Taipei bar landed: ready (got {seen})")

naive = types.SimpleNamespace(fetch_data=lambda h: pd.DataFrame(
    {"Close": 1.0}, index=pd.date_range(end="2026-09-23 04:00", periods=5, freq="1h")))
seen, ready, _ = wfb._check_freshness(naive, expected)
check(ready and seen == datetime(2026, 9, 23, 4, 0), "naive (UTC) index: unchanged")


def type_c(h):
    a, b = frame("2026-09-23 12:00")["Close"], frame("2026-09-23 11:00")["Close"]
    close = pd.concat({"2330": a, "2317": b}, axis=1)
    return close, close.copy()


seen, ready, who = wfb._check_freshness(types.SimpleNamespace(fetch_data=type_c), expected)
check(not ready and who == "2317" and seen == datetime(2026, 9, 23, 3, 0),
      f"Type C, one Taipei symbol an hour behind: not ready, straggler named (got {who}, {seen}, {ready})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
