"""A crypto month must not be frozen by the read that happens to run at the rollover, and a batch
fetch must not store half a month as a whole one.

Pins, on a fixed clock against in-process fakes (no network; file mtimes follow the clock):
  1. rollover, alpha and kline: the 00:00:05 tick lacks last month's closing bar; a read inside
     the 30-minute grace gets it from a tail request, a forming bar is replaced, the first read
     after the grace asks for the tail once more and flags it, and nothing is asked after that;
  2. a failed or empty re-read keeps the cache, flags nothing, and is asked again;
  3. batch: the 2026-09 replay (a first run from 09-21, a later one from 09-01) and a mid-month
     `end` both end with whole months, the request is month-aligned, the answer is not widened;
  4. files from before the flag: a whole month costs no request, one completed at a rollover
     costs a tail request (its last bar may have been forming), a half month is read whole, a
     month short at its tail from its last bar, through /batch too, and a symbol with no rows
     left does not re-ask forever; the TTL check's mtime refresh hides nothing;
  5. live: fetch_kline's last bar inside the grace is the one it is without this rule; a batch
     tick survives a failed re-read of an older month and reads only what is missing, at most
     three windows per tick; inside the grace a hole or a listing month costs a tail request;
     past the grace an answer short of the month's end is not final for a day;
  6. a flagged and an unflagged month read back together; series not listed stay untouched.
Run: cd blave-agent && .venv/bin/python tests/check_crypto_cache_month_seam.py
"""
import os, shutil, sys, tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pandas as pd
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="cryptoseam-"))
d._CACHE_DIR = TMP / "cache"
os.environ.pop("BLAVE_FETCH_FRESH_SINCE", None)
os.environ["BLAVE_KLINE_SOURCE"] = "blave"

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)


class Clock(datetime):
    at = datetime(2026, 11, 1)

    @classmethod
    def utcnow(cls):
        return cls.at

    @classmethod
    def now(cls, tz=None):
        return cls.at if tz is None else cls.at.replace(tzinfo=timezone.utc).astimezone(tz)


d.datetime = Clock


def mtimes():
    return {p: p.stat().st_mtime_ns for p in d._CACHE_DIR.rglob("*.parquet")}


def at(when, fn, *a, **kw):
    """Run fn at `when`; files it wrote carry that time, as they would have."""
    Clock.at = when
    before = mtimes()
    try:
        return fn(*a, **kw)
    finally:
        ts = when.replace(tzinfo=timezone.utc).timestamp()
        for p, ns in mtimes().items():
            if before.get(p) != ns:
                os.utime(p, (ts, ts))


def flagged(path):
    return bool((d._read_schema(path).metadata or {}).get(b"blave_month_settled"))


def bars(start, end, freq):
    return pd.date_range(start, end, freq=freq, inclusive="left")


class Source:
    """raw_fn(start, end): bars up to `published` (exclusive); end exclusive like the cache's spans."""
    def __init__(self, published, freq="1h", value=lambda t: 1.0):
        self.published, self.freq, self.value, self.calls, self.mode = published, freq, value, [], "ok"

    def __call__(self, s, e):
        self.calls.append((s, e))
        if self.mode == "raise" and s < "2026-11":     # last month's data only: this month's delta is its own case
            raise RuntimeError("api down")
        if self.mode == "empty" and s < "2026-11":
            return pd.DataFrame()
        idx = [t for t in bars("2026-01-01", "2026-12-01", self.freq)
               if pd.Timestamp(s) <= t < pd.Timestamp(e) and t < pd.Timestamp(self.published)]
        return pd.DataFrame({"alpha": [self.value(t) for t in idx]}, index=pd.DatetimeIndex(idx))


def fresh():
    shutil.rmtree(d._CACHE_DIR, ignore_errors=True)
    d._CACHE_DIR.mkdir(parents=True)


def seed_month(prefix, params, idx, written, value=1.0):
    mdir = d._monthly_cache_dir(prefix, params)
    mdir.mkdir(parents=True, exist_ok=True)
    idx = pd.DatetimeIndex(idx)
    path = mdir / f"{idx[0]:%Y-%m}.parquet"
    pd.DataFrame({"alpha": value}, index=idx).to_parquet(path)
    ts = written.replace(tzinfo=timezone.utc).timestamp()
    os.utime(path, (ts, ts))
    return path


LAST = pd.Timestamp("2026-10-31 23:00")

# 1. the rollover
for prefix in ("whale_hunter", "funding_rate", "kline3", "oi_history"):
    fresh()
    params = {"symbol": "BTCUSDT", "period": "1h"}
    path = d._monthly_cache_dir(prefix, params) / "2026-10.parquet"
    src = Source("2026-10-31 23:00", value=lambda t: 2.0 if t == pd.Timestamp("2026-10-31 22:00") else 1.0)
    run = lambda when: at(when, d._extend_cache_monthly, prefix, params, src, "2026-10-01", None)
    run(datetime(2026, 10, 31, 23, 5))
    src.published = "2026-11-01 00:00"                # the closing bar exists from here on …
    src.value = lambda t: 1.0
    keep = src.published
    src.published = "2026-10-31 23:00"                # … but not yet at the tick
    run(datetime(2026, 11, 1, 0, 0, 5))
    check(LAST not in d._read_parquet(path).index, f"{prefix}: the tick at the rollover has no closing bar (the setup)")
    check(not flagged(path), f"{prefix}: that read settles nothing")
    src.published = keep
    src.calls.clear()
    out = run(datetime(2026, 11, 1, 0, 12))
    check(LAST in out.index, f"{prefix}: a read inside the grace gets the closing bar")
    check(src.calls[0] == ("2026-10-31", "2026-11-01"), f"{prefix}: …asking for the tail, not the month ({src.calls[0]})")
    check(not flagged(path), f"{prefix}: …and still settles nothing")
    src.calls.clear()
    run(datetime(2026, 11, 1, 0, 31))
    check(src.calls[0] == ("2026-10-31", "2026-11-01") and flagged(path),
          f"{prefix}: the first read after the grace asks for the tail once more and flags it ({src.calls[0]})")
    src.calls.clear()
    run(datetime(2026, 11, 1, 1, 5))
    run(datetime(2026, 11, 9, 1, 5))
    check(not any(s < "2026-11-01" for s, _ in src.calls), f"{prefix}: never asked again ({src.calls})")

fresh()
params = {"symbol": "BTCUSDT", "period": "1h"}
src = Source("2026-11-01 00:00", value=lambda t: 3.0)
path = seed_month("kline3", params, bars("2026-10-01", "2026-11-01", "1h"), datetime(2026, 11, 1, 0, 0, 5))
out = at(datetime(2026, 11, 1, 0, 5), d._extend_cache_monthly, "kline3", params, src, "2026-10-01", None)
check(out.loc[LAST, "alpha"] == 3.0, "a bar cached while forming is replaced by the final one")

# 2. a re-read that fails
fresh()
params = {"symbol": "ETHUSDT", "period": "1h"}
src = Source("2026-11-01 00:00")
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-31 23:00", "1h"), datetime(2026, 11, 1, 0, 1))
run = lambda when: at(when, d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
src.mode = "raise"
out = run(datetime(2026, 11, 1, 0, 40))
check(len(out) and not flagged(path), "a failed re-read serves the cache and flags nothing")
src.mode = "empty"
run(datetime(2026, 11, 1, 1, 40))
check(not flagged(path), "an empty 200 for a month with rows flags nothing")
src.mode = "ok"
out = run(datetime(2026, 11, 1, 2, 40))
check(LAST in out.index and flagged(path), "the next read fills it and flags it")

fresh()
src = Source("2026-11-01 00:00")
src.mode = "raise"
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-31 23:00", "1h"), datetime(2026, 10, 31, 22))
raised = False
try:
    run(datetime(2026, 11, 1, 0, 1))
except RuntimeError:
    raised = True
check(raised, "the first completing read still raises: the cache is known to be behind")

fresh()
src = Source("2026-10-20")
src.mode = "empty"
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-20", "1h"), datetime(2026, 10, 25))
run(datetime(2026, 11, 3, 2))
check(flagged(path), "a day past the mark an empty answer is believed: a dead series stops asking")
src.calls.clear()
run(datetime(2026, 11, 3, 3))
check(not any(s < "2026-11-01" for s, _ in src.calls), f"…for good ({src.calls})")


# 3. batch
class R:
    def __init__(self, body): self._b = body
    def json(self): return self._b


class Api:
    def __init__(self, ids, freq="1d", last="2026-11-01", gone=()):
        self.ids, self.freq, self.last, self.gone, self.calls = ids, freq, last, set(gone), []
        self.fail_before = None           # server `failed` for any window starting earlier

    def get(self, url, **kw):
        p = kw["params"]
        self.calls.append((p["start_date"], p["end_date"]))
        if self.fail_before and p["start_date"] < self.fail_before:
            return R({"data": {}, "failed": p["symbols"].split(",")})
        idx = [t for t in bars("2025-01-01", self.last, self.freq)
               if pd.Timestamp(p["start_date"]) <= t < pd.Timestamp(p["end_date"]) + pd.Timedelta(days=1)]
        rows = [{"time": int(t.timestamp()), "open": 1.0, "high": 2.0, "low": 1.0, "close": 1.5, "volume": 3.0}
                for t in idx]
        return R({"data": {s: rows for s in p["symbols"].split(",") if s not in self.gone}, "failed": []})


SYMS = ["BTCUSDT", "ETHUSDT"]
def rows(prefix, sym, ym):
    p = d._monthly_cache_dir(prefix, {"id": sym}) / f"{ym}.parquet"
    return len(d._read_parquet(p))


fresh()
api = Api(SYMS)
d._retry_get = api.get
batch = lambda when, start, end: at(when, d.fetch_kline_batch, SYMS, "1d", start, end, {})
Now = datetime(2026, 10, 25, 3)
first = batch(Now, "2026-09-21", None)
check(api.calls[0][0] == "2026-09-01", f"a mid-month start asks from the 1st ({api.calls[0]})")
check(first["BTCUSDT"].index[0] == pd.Timestamp("2026-09-21"), "…and the answer still starts where the caller said")
check(rows("kline3_1d", "BTCUSDT", "2026-09") == 30, f"2026-09 is whole ({rows('kline3_1d', 'BTCUSDT', '2026-09')} rows)")
second = batch(Now, "2026-09-01", None)
check(len(second["BTCUSDT"].loc["2026-09"]) == 30, "the later run from 09-01 sees all 30 days")

fresh()
api = Api(SYMS, freq="1h")
d._retry_get = api.get
batch = lambda when, start, end: at(when, d.fetch_kline_batch, SYMS, "1h", start, end, {})
got = batch(Now, "2026-08-15", "2026-09-20")
check(rows("kline3_1h", "BTCUSDT", "2026-08") == 744 and rows("kline3_1h", "BTCUSDT", "2026-09") == 720,
      "a mid-month end in a past month stores whole months too")
check(got["BTCUSDT"].index[-1] < pd.Timestamp("2026-09-21"), "…and the answer still stops where the caller said")

fresh()
api = Api(SYMS, freq="1h", last="2026-10-31 23:00")
d._retry_get = api.get
hourly = lambda when: at(when, d.fetch_kline_batch, SYMS, "1h", "2026-10-01", None, {})
hourly(datetime(2026, 10, 31, 23, 5))
api.last, api.calls = "2026-11-01 00:00", []
out = hourly(datetime(2026, 11, 1, 0, 0, 5))
check(api.calls[0][0] == "2026-10-01", f"batch: the completing read at the rollover asks for the month ({api.calls[0]})")
api.calls = []
out = hourly(datetime(2026, 11, 1, 0, 12))
check(api.calls[0][0] == "2026-10-31" and len(api.calls) == 1,
      f"batch: a later read inside the grace asks for the closing bars only ({api.calls})")
check(out["BTCUSDT"].index[-1] == LAST, "…and has the closing bar")
api.calls = []
hourly(datetime(2026, 11, 1, 0, 31))
oct_file = d._monthly_cache_dir("kline3_1h", {"id": "BTCUSDT"}) / "2026-10.parquet"
check(api.calls[0][0] == "2026-10-31" and flagged(oct_file), f"batch: past the grace one more tail read flags it ({api.calls})")
api.calls = []
hourly(datetime(2026, 11, 1, 1, 5))
check(api.calls[0][0] == "2026-11-01", f"batch: then back to this month ({api.calls})")

# 4. files from before the flag
fresh()
params = {"symbol": "SOLUSDT", "period": "1h"}
src = Source("2026-11-02")
whole = seed_month("kline3", params, bars("2026-08-01", "2026-09-01", "1h"), datetime(2026, 9, 5))
halfm = seed_month("kline3", params, bars("2026-09-21", "2026-10-01", "1h"), datetime(2026, 9, 25))
short = seed_month("kline3", params, bars("2026-10-01", "2026-10-31 22:00", "1h"), datetime(2026, 11, 1, 0, 1))
run = lambda: at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, "kline3", params, src, "2026-08-01", None)
run()
check(src.calls[:2] == [("2026-10-31", "2026-11-01"), ("2026-09-01", "2026-10-01")],
      f"only the months with a gap are read, a short tail from its last bar ({src.calls})")
check(flagged(whole), "a whole month is flagged with no request")
check(flagged(halfm) and len(d._read_parquet(halfm)) == 720, "a half month is filled and flagged")
check(flagged(short) and len(d._read_parquet(short)) == 744, "a month short at its tail is filled and flagged")
src.calls.clear()
run()
check(not any(s < "2026-11-01" for s, _ in src.calls), f"…once ({src.calls})")

fresh()
params = {"symbol": "LTCUSDT", "period": "1h"}
src = Source("2026-11-02", value=lambda t: 5.0)
path = seed_month("kline3", params, bars("2026-09-01", "2026-10-01", "1h"), datetime(2026, 10, 1, 0, 1))
at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, "kline3", params, src, "2026-09-01", "2026-09-30")
check(src.calls == [("2026-09-30", "2026-10-01")] and flagged(path), f"a month completed at a rollover: one tail read ({src.calls})")
check(d._read_parquet(path).loc["2026-09-30 23:00", "alpha"] == 5.0, "…which replaces a closing bar that was still forming")

fresh()
params = {"symbol": "XRPUSDT", "period": "1h"}
src = Source("2026-11-02")
gap = bars("2026-09-01", "2026-10-01", "1h")
path = seed_month("kline3", params, gap[(gap < "2026-09-10") | (gap >= "2026-09-12")], datetime(2026, 10, 2))
at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, "kline3", params, src, "2026-09-01", "2026-09-30")
check(len(d._read_parquet(path)) == 720, "a gap inside a month counts too")

fresh()
params = {"symbol": "ADAUSDT", "period": "8h"}
src = Source("2026-11-02", freq="8h")
path = seed_month("funding_rate", params, bars("2026-09-01", "2026-10-01", "8h"), datetime(2026, 10, 2))
at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, "funding_rate", params, src, "2026-09-01", "2026-09-30")
check(flagged(path) and not src.calls, f"8h bars: a whole month ends at 16:00, no request ({src.calls})")

fresh()
params = {"symbol": "BNBUSDT", "period": "1h"}
src = Source("2026-11-02")
path = seed_month("oi_history", params, bars("2026-09-01", "2026-09-29", "1h"), datetime(2026, 11, 1, 12))
at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, "oi_history", params, src, "2026-09-01", "2026-09-30",
   empty_marker_ttl_hours=24)
check(("2026-09-28", "2026-10-01") in src.calls and len(d._read_parquet(path)) == 720,
      f"a tail hole the TTL check's edge tolerance passes is read ({src.calls})")

fresh()
api = Api(SYMS + ["LUNAUSDT"], gone={"LUNAUSDT"})
d._retry_get = api.get
ALL = SYMS + ["LUNAUSDT"]
for sym in SYMS:
    seed = seed_month("kline3_1d", {"id": sym}, bars("2026-09-21", "2026-10-01", "1D"), datetime(2026, 9, 25))
seed_month("kline3_1d", {"id": "LUNAUSDT"}, bars("2026-09-21", "2026-10-01", "1D"), datetime(2026, 9, 25))
for sym in ALL:
    seed_month("kline3_1d", {"id": sym}, bars("2026-10-01", "2026-11-01", "1D"), datetime(2026, 11, 1, 1))
go = lambda: at(datetime(2026, 11, 2, 3), d.fetch_kline_batch, ALL, "1d", "2026-09-01", None, {})
out = go()
check(len(out["BTCUSDT"].loc["2026-09"]) == 30, "a half month heals through /batch")
check(all(c[0] == "2026-09-01" for c in api.calls[-1:]), f"…asked from the 1st ({api.calls[-2:]})")
api.calls.clear()
go()
check(all(c[0] >= "2026-10-01" for c in api.calls), f"…once, also for a symbol with no rows left ({api.calls})")

# 5. live bar boundary
fresh()
os.environ["BLAVE_KLINE_SOURCE"] = "blave"
src = Source("2026-11-01 01:00", value=lambda t: 1.0)   # the api's bars include the one still forming
frame = lambda s, e: src(s, e).rename(columns={"alpha": "Close"}).assign(Open=1.0, High=1.0, Low=1.0, Volume=1.0)
d._fetch_kline_raw = lambda sym, itv, s, e, h, r=6: frame(s, e)
at(datetime(2026, 10, 31, 23, 5), d.fetch_kline, "BTCUSDT", "1h", "2026-10-01", None, {})
live = lambda when: d._drop_forming_bar(at(when, d.fetch_kline, "BTCUSDT", "1h", "2026-10-01", None, {}),
                                        "1h", now=when, force=True)
out = live(datetime(2026, 11, 1, 0, 5))
check(out.index[-1] == LAST, f"inside the grace the last closed bar is the one before the hour ({out.index[-1]})")
src.published = "2026-11-01 02:00"
out = live(datetime(2026, 11, 1, 1, 5))
check(out.index[-1] == pd.Timestamp("2026-11-01 00:00"), f"…and the next hour moves one bar ({out.index[-1]})")
check(not out.index.has_duplicates and out.index.is_monotonic_increasing, "no doubled bar at the seam")

# a live batch tick and the older months
def half_month_setup(ids):
    fresh()
    for sym in ids:
        seed_month("kline3_1h", {"id": sym}, bars("2026-09-21", "2026-10-01", "1h"), datetime(2026, 10, 3))
        seed_month("kline3_1h", {"id": sym}, bars("2026-10-01", "2026-11-01", "1h"), datetime(2026, 11, 1, 2))


class Tick:
    def __init__(self, when): self.when = when
    def __enter__(self):
        d._live_feeds += 1
    def __exit__(self, *a):
        d._live_feeds -= 1


half_month_setup(SYMS)
api = Api(SYMS, freq="1h", last="2026-11-02 04:00")
d._retry_get = api.get
api.fail_before = "2026-11-01"
tick = lambda when: at(when, d.fetch_kline_batch, SYMS, "1h", "2026-09-01", None, {})
with Tick(None):
    out = tick(datetime(2026, 11, 2, 4, 0, 5))
sep = d._monthly_cache_dir("kline3_1h", {"id": "BTCUSDT"}) / "2026-09.parquet"
check(set(out) == set(SYMS) and out["BTCUSDT"].index[-1] >= pd.Timestamp("2026-11-02 02:00"),
      "a live tick survives a server failure on an older month: it still has this month's bars")
check(len(d._read_parquet(sep)) == 240 and not flagged(sep), "…the month stays as it was, unflagged")
api.fail_before, api.calls = None, []
with Tick(None):
    out = tick(datetime(2026, 11, 2, 5, 0, 5))
check(("2026-09-01", "2026-09-30") in api.calls and not any(c[0] < "2026-09" or c == ("2026-09-01", "2026-11-03") for c in api.calls),
      f"the next tick reads the missing month, not the whole range ({api.calls})")
check(len(out["BTCUSDT"].loc["2026-09"]) == 720 and flagged(sep), "…and this tick's frame already has it")

fresh()
LIVE = ["BTCUSDT"]
for ym in ("2026-05", "2026-06", "2026-07", "2026-08", "2026-09"):
    nxt = d._next_month(ym)
    seed_month("kline3_1h", {"id": "BTCUSDT"}, bars(f"{ym}-01", f"{nxt}-01", "1h"), datetime(int(nxt[:4]), int(nxt[5:7]), 1, 0, 1))
seed_month("kline3_1h", {"id": "BTCUSDT"}, bars("2026-10-01", "2026-11-01", "1h"), datetime(2026, 11, 3))
api = Api(LIVE, freq="1h", last="2026-11-02 04:00")
d._retry_get = api.get
with Tick(None):
    at(datetime(2026, 11, 2, 4, 0, 5), d.fetch_kline_batch, LIVE, "1h", "2026-05-01", None, {})
old = [c for c in api.calls if c[0] < "2026-10"]
check(len(old) == 3 and old[0][0] > old[-1][0] and all(c[1][:7] == c[0][:7] for c in old),
      f"a live tick re-reads at most three older windows, newest first, the rest wait ({old})")
api.calls = []
at(datetime(2026, 11, 2, 4, 30), d.fetch_kline_batch, LIVE, "1h", "2026-05-01", None, {})
check(len([c for c in api.calls if c[0] < "2026-10"]) == 2, f"…a backtest takes what is left at once ({api.calls})")

# inside the grace
fresh()
params = {"symbol": "AVAXUSDT", "period": "5min"}
idx = bars("2026-10-01", "2026-10-31 23:00", "5min")
path = seed_month("whale_hunter", params, idx[(idx < "2026-10-10") | (idx >= "2026-10-10 01:00")], datetime(2026, 11, 1, 0, 1))
src = Source("2026-11-01", freq="5min")
at(datetime(2026, 11, 1, 0, 12), d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
check(src.calls[0][0] == "2026-10-31", f"inside the grace a month with a hole still costs a tail read ({src.calls[0]})")
src.calls.clear()
at(datetime(2026, 11, 1, 0, 40), d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
check(src.calls[0] == ("2026-10-01", "2026-11-01") and flagged(path) and len(d._read_parquet(path)) == 8928,
      f"past the grace the hole is read whole ({src.calls[0]})")

fresh()
BOTH = ["BTCUSDT", "NEWUSDT"]
seed_month("kline3_5min", {"id": "BTCUSDT"}, bars("2026-10-01", "2026-10-31 23:00", "5min"), datetime(2026, 11, 1, 0, 1))
seed_month("kline3_5min", {"id": "NEWUSDT"}, bars("2026-10-20", "2026-10-31 23:00", "5min"), datetime(2026, 11, 1, 0, 1))
api = Api(BOTH, freq="5min", last="2026-11-01 00:10")
d._retry_get = api.get
at(datetime(2026, 11, 1, 0, 12), d.fetch_kline_batch, BOTH, "5min", "2026-10-01", None, {})
check(api.calls[0][0] == "2026-10-31", f"a listing month in the batch does not widen the window ({api.calls[0]})")

# past the grace, api still behind
fresh()
params = {"symbol": "LINKUSDT", "period": "1h"}
src = Source("2026-10-31 21:00")
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-31 21:00", "1h"), datetime(2026, 11, 1, 0, 1))
run = lambda when: at(when, d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
run(datetime(2026, 11, 1, 0, 31))
check(not flagged(path), "past the grace an answer short of the month's end flags nothing")
src.published = "2026-11-01"
out = run(datetime(2026, 11, 1, 1, 5))
check(LAST in out.index and flagged(path), "…the api catches up, the bar lands, the month is flagged")
fresh()
src = Source("2026-10-20")
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-20", "1h"), datetime(2026, 11, 1, 0, 1))
run(datetime(2026, 11, 1, 0, 31))
check(not flagged(path), "a series that stopped mid-month is doubted first")
run(datetime(2026, 11, 2, 1))
check(flagged(path), "…and believed a day later")

# what a batch stores
fresh()
api = Api(SYMS, freq="1h", last="2026-11-01 00:10")
d._retry_get = api.get
at(datetime(2026, 11, 1, 0, 12), d.fetch_kline_batch, SYMS, "1h", "2026-09-01", None, {})
mdir = d._monthly_cache_dir("kline3_1h", {"id": "BTCUSDT"})
check(flagged(mdir / "2026-09.parquet"), "a cold batch flags a month past its grace")
check(not flagged(mdir / "2026-10.parquet"), "…not one inside it")

# the local check
fresh()
params = {"symbol": "NEARUSDT", "period": "1h"}
head = seed_month("kline3", params, bars("2026-09-01 02:00", "2026-10-01", "1h"), datetime(2026, 10, 5))
check(d._month_has_gap(head, "2026-09"), "two bars short at the head is a gap")
one = seed_month("kline3", params, bars("2026-08-01", "2026-08-31 23:00", "1h"), datetime(2026, 9, 5))
check(d._month_has_gap(one, "2026-08"), "one bar short at the tail is a gap")
fine = seed_month("kline3", params, bars("2026-07-01", "2026-08-01", "1h"), datetime(2026, 8, 5))
check(not d._month_has_gap(fine, "2026-07"), "a whole month is not")
mdir = d._monthly_cache_dir("kline3", params)
pd.DataFrame().to_parquet(mdir / "2026-06.parquet")
empty = mdir / "2026-06.parquet"
os.utime(empty, (datetime(2026, 7, 5, tzinfo=timezone.utc).timestamp(),) * 2)
Clock.at = datetime(2026, 11, 2, 3)
check(not d._month_unsettled(empty, "2026-06", d._CRYPTO_GRACE), "an empty-month marker asks for nothing")

# every crypto series on the clock
import re
source = Path(d.__file__).read_text(encoding="utf-8")
slugs = set(re.findall(r"_fetch_alpha\(\s*'([a-z_]+)/", source)) | set(re.findall(r"_fetch_alpha\(f'([a-z_]+)/", source))
listed = slugs | {"kline3", "kline3_1h", "bingx_kline", "oi_history"}
check(len(slugs) >= 11 and all(d._settle_delay(x) == d._CRYPTO_GRACE for x in listed),
      f"every alpha endpoint and kline cache is listed ({sorted(x for x in listed if d._settle_delay(x) != d._CRYPTO_GRACE)})")
for name in ("twstock_minute_1m", "twfutures3_1d", "twfutures_bav"):
    check(d._settle_delay(name) == timedelta(days=7), f"{name} keeps the 7-day clock")

# Taiwan months share the re-read path
fresh()
params = {"symbol": "TXF"}
T = "twfutures3_1m"
src = Source("2026-11-02")
src.mode = "raise"
path = seed_month(T, params, bars("2026-10-01", "2026-11-01", "1h"), datetime(2026, 11, 1, 2))
run = lambda when: at(when, d._extend_cache_monthly, T, params, src, "2026-10-01", None)
out = run(datetime(2026, 11, 8, 2))
check(len(out) and not flagged(path), "Taiwan: a failed settle read serves the cache and flags nothing")
src.mode = "empty"
run(datetime(2026, 11, 8, 2, 30))
check(not flagged(path), "Taiwan: an empty answer inside eight days flags nothing")
src.mode = "ok"
run(datetime(2026, 11, 8, 3))
check(flagged(path), "Taiwan: the next good read does")

# 6. mixed files, unlisted series
fresh()
params = {"symbol": "DOTUSDT", "period": "1h"}
seed_month("kline3", params, bars("2026-08-01", "2026-09-01", "1h"), datetime(2026, 9, 1, 2))
path = seed_month("kline3", params, bars("2026-09-01", "2026-10-01", "1h"), datetime(2026, 10, 1, 2))
d._stamp_settled(path)
out = pd.read_parquet([d._monthly_cache_dir("kline3", params) / f"{ym}.parquet" for ym in ("2026-08", "2026-09")])
check(len(out) == 744 + 720, "a flagged and an unflagged month read back together")

fresh()
params = {"dataset": "GLBX", "symbol": "ES"}
src = Source("2026-11-02")
path = seed_month("db_ohlcv1d", params, bars("2026-10-01", "2026-10-20", "1h"), datetime(2026, 11, 1, 0, 1))
at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, "db_ohlcv1d", params, src, "2026-10-01", None)
check(("2026-10-01", "2026-11-01") not in src.calls and not flagged(path), "a series not listed is left as it was")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
