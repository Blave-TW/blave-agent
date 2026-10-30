"""lib.data.price_at takes an event's price from the last bar already closed at t.

Kline rows are labelled by open time, so `close.asof(t)` reads the bar that opens at t and
closes an interval later: an FOMC event study done that way starts every 24h window an hour
late (−0.422% over 54 events instead of +0.031%). Asserted here, offline:

  S  synthetic 1h bars: on the hour, past the hour, a tz-aware t, a Series input, 15min bars;
     a missing bar → NaN (also exactly one interval after the last close), t before the
     first close → NaN.
  F  tests/fixtures/fomc_btc_1h.json (54 scheduled FOMC statements 2020-01..2026-10, BTCUSDT
     1h): the mean 24h return from price_at(t) to price_at(t + 24h) is +0.031%; the asof
     path on the same bars gives −0.422%.

Run: cd blave-agent && .venv/bin/python tests/check_price_at.py
"""
import json
import math
import os
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

from lib.data import price_at

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


idx = pd.date_range("2026-01-01 00:00", periods=6, freq="1h")
df = pd.DataFrame({"Close": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0]}, index=idx)

check(price_at(df, "2026-01-01 03:00", "1h") == 102.0,
      "on the hour: 03:00 → bar 02:00 (closed at 03:00), not bar 03:00")
check(price_at(df, "2026-01-01 03:30", "1h") == 102.0,
      "past the hour: 03:30 → bar 02:00; bar 03:00 is still forming")
check(price_at(df, "2026-01-01 03:59:59", "1h") == 102.0, "03:59:59 → still bar 02:00")
check(price_at(df, "2026-01-01 06:00", "1h") == 105.0, "06:00 → the last bar 05:00")
check(price_at(df, pd.Timestamp("2025-12-31 22:00", tz="America/New_York"), "1h") == 102.0,
      "tz-aware t (22:00 ET = 03:00 UTC) → bar 02:00")
check(price_at(df["Close"], "2026-01-01 03:00", "1h") == 102.0, "a close Series works the same")

gap = df.drop(pd.Timestamp("2026-01-01 02:00"))
check(math.isnan(price_at(gap, "2026-01-01 03:00", "1h")),
      "missing bar 02:00, t 03:00 → NaN, not bar 01:00's close")
check(math.isnan(price_at(gap, "2026-01-01 03:30", "1h")), "missing bar 02:00, t 03:30 → NaN")
check(price_at(gap, "2026-01-01 04:00", "1h") == 103.0, "after the gap, 04:00 → bar 03:00")
check(math.isnan(price_at(df, "2026-01-01 07:00", "1h")),
      "07:00 exactly one interval past the last close → NaN")
check(math.isnan(price_at(df, "2026-01-01 00:30", "1h")), "before the first bar closes → NaN")

q = pd.DataFrame({"Close": [1.0, 2.0, 3.0]},
                 index=pd.date_range("2026-01-01 10:00", periods=3, freq="15min"))
check(price_at(q, "2026-01-01 10:40", "15min") == 2.0, "15min bars: 10:40 → bar 10:15")

with open(os.path.join(ROOT, "tests", "fixtures", "fomc_btc_1h.json")) as f:
    fx = json.load(f)
events = pd.to_datetime(fx["events_utc"])
close = pd.concat([pd.Series(b, index=pd.date_range(t - pd.Timedelta(hours=2), periods=len(b), freq="1h"))
                   for t, b in zip(events, fx["closes"])]).sort_index()
close = close[~close.index.duplicated()]
day = pd.Timedelta(hours=24)

r = pd.Series([price_at(close, t + day, "1h") / price_at(close, t, "1h") - 1 for t in events]) * 100
check(len(events) == 54 and r.notna().sum() == 54, f"FOMC: 54 events all priced ({r.notna().sum()})")
check(round(r.mean(), 3) == 0.031, f"FOMC: mean 24h return from the statement = +0.031% ({r.mean():.4f})")
late = pd.Series([close.asof(t + day) / close.asof(t) - 1 for t in events]) * 100
check(round(late.mean(), 3) == -0.422, f"FOMC: the asof path is an hour late, −0.422% ({late.mean():.4f})")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
