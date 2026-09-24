"""Minimal check: lib.data.fetch_fear_greed (alternative.me Crypto Fear & Greed, key-free).
No network: the session is stubbed and replays tests/fixtures/fear_greed.json (one real fetch,
2026-09-24 08:16 UTC, trimmed to the last 95 rows).

  - parse: one row per UTC day (naive midnight index, ascending), value float 0–100,
    classification text, values as recorded (09-22 78 Extreme Greed, 09-23 / 09-24 71 Greed);
    attrs['source'] = the attribution line; `limit` = days from start (0 = whole history)
  - cache: a past-month range makes one request, the second call none
  - FEED_TIMING['fear_greed']: the day's row counts from D 01:00 UTC
  - align_feed on hourly bars: the D 00:00 bar (close 01:00) is the first to see D; live at
    that bar with D missing → FeedNotPublished due D 01:00; the 23:00 bar of D-1 needs D-1 only

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_fear_greed.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd
import requests

import lib.data as D

FIX = Path(ROOT) / "tests" / "fixtures" / "fear_greed.json"
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


class FakeResponse:
    status_code = 200

    def __init__(self, body):
        self.content = body

    def json(self):
        return json.loads(self.content)

    def raise_for_status(self):
        pass


class FakeSession:
    def __init__(self):
        self.calls = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, dict(params or {})))
        if url != D._FNG_URL:
            raise requests.exceptions.ConnectionError(f"no fixture for {url}")
        return FakeResponse(FIX.read_bytes())


D.time.sleep = lambda s: None                      # the 1 req/s throttle is not slept in the check


def fresh():
    D._CACHE_DIR = Path(tempfile.mkdtemp())
    D._TW_PUBLIC_SESSION = FakeSession()
    D._TW_PUBLIC_LIMITER = D._RateLimiter(1, 1.0)
    return D._TW_PUBLIC_SESSION


def t_parse():
    s = fresh()
    raw = D._fetch_fear_greed_raw("2026-09-01", None)
    check(isinstance(raw.index, pd.DatetimeIndex) and raw.index.tz is None and raw.index.is_monotonic_increasing
          and (raw.index == raw.index.normalize()).all(),
          "one row per UTC day: naive midnight index, ascending")
    check(raw.loc["2026-09-22", "value"] == 78.0 and raw.loc["2026-09-22", "classification"] == "Extreme Greed"
          and raw.loc["2026-09-24", "value"] == 71.0 and raw.loc["2026-09-24", "classification"] == "Greed"
          and raw["value"].between(0, 100).all() and raw["value"].dtype == float,
          "values as recorded: 09-22 78 Extreme Greed, 09-24 71 Greed; float 0–100")
    lim = s.calls[-1][1].get("limit")
    check(s.calls[-1][0] == D._FNG_URL and s.calls[-1][1].get("format") == "json" and 25 <= lim < 3000,
          f"limit = days from start to today (+1 spare; 25 on 2026-09-24), never the whole history for a short range (got {lim})")
    D._fetch_fear_greed_raw("2018-02-01", None)
    check(s.calls[-1][1]["limit"] == 0, "start at the first row (2018-02-01) → limit=0 (whole history)")


def t_entry_and_cache():
    s = fresh()
    df = D.fetch_fear_greed("2026-07-01", "2026-08-31")
    check(list(df.columns) == ["value", "classification"] and len(df) == 62
          and df.index[0] == pd.Timestamp("2026-07-01") and df.index[-1] == pd.Timestamp("2026-08-31"),
          f"fetch_fear_greed: value/classification, 62 rows for Jul–Aug 2026 (got {len(df)})")
    check(df.attrs.get("source") == D._FNG_SOURCE and "alternative.me" in D._FNG_SOURCE,
          "attrs['source'] carries the alternative.me attribution line")
    check(len(s.calls) == 1, f"a past-month range = one request (got {len(s.calls)})")
    again = D.fetch_fear_greed("2026-07-01", "2026-08-31")
    check(len(s.calls) == 1 and again.equals(df), "second call: served from the monthly cache, no request")
    check(sorted(p.name for p in (D._CACHE_DIR / "fear_greed_alternative.me").glob("*.parquet")) == ["2026-07.parquet", "2026-08.parquet"],
          "two month files under cache/fear_greed_alternative.me/")


def t_feed_timing():
    spec = D.FEED_TIMING["fear_greed"]
    due = spec["available"](pd.DatetimeIndex(["2026-09-24"], tz="UTC"))[0]
    check(due == pd.Timestamp("2026-09-24 01:00", tz="UTC") and spec["tz"] == "UTC" and "00:00 UTC" in spec["basis"],
          f"FEED_TIMING fear_greed: the day's row counts from 01:00 UTC (got {due})")
    hours = pd.date_range("2026-09-23 20:00", "2026-09-24 03:00", freq="1h")   # naive UTC, like fetch_kline
    bars = pd.DataFrame({"Close": 1.0}, index=hours)
    feed = pd.DataFrame({"value": [71.0, 78.0], "classification": ["Greed", "Extreme Greed"]},
                        index=pd.DatetimeIndex(["2026-09-23", "2026-09-24"]))
    got = D.align_feed(bars, feed, "fear_greed", "1h", bar_tz="UTC")["value"]
    check((got.loc[:"2026-09-23 23:00"] == 71.0).all() and (got.loc["2026-09-24 00:00":] == 78.0).all(),
          "1h bars: through the 09-23 23:00 bar (close 00:00) the 09-23 row; from the 09-24 00:00 bar (close 01:00) the 09-24 row")
    try:
        with D.live_feeds():
            D.align_feed(bars, feed.iloc[:1], "fear_greed", "1h", bar_tz="UTC")
        check(False, "live at the 09-24 00:00 bar without the 09-24 row → FeedNotPublished")
    except D.FeedNotPublished as e:
        check(e.due_at == pd.Timestamp("2026-09-24 01:00", tz="UTC"),
              f"live at the 09-24 00:00 bar without the 09-24 row → FeedNotPublished due 01:00 UTC (got {e.due_at})")
    with D.live_feeds():
        early = D.align_feed(bars.loc[:"2026-09-23 23:00"], feed.iloc[:1], "fear_greed", "1h", bar_tz="UTC")
    check(early["value"].iloc[-1] == 71.0, "live at the 09-23 23:00 bar: the 09-24 row is not due yet → no raise")


def main():
    t_parse()
    t_entry_and_cache()
    t_feed_timing()
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
