"""A crypto month must not be frozen by the read that happens to run at the rollover, a batch fetch
must not store half a month as a whole one, and neither fix may touch a file from before them.

Pins, on a fixed clock against in-process fakes (no network; file mtimes follow the clock):
  1. rollover, alpha and kline: the 00:00:05 tick lacks last month's closing bar; a read inside
     the 30-minute grace gets it from a tail request, a forming bar is replaced, the first read
     after the grace asks for the tail once more and closes the month, and nothing is asked after;
  2. a failed or empty re-read keeps the cache, closes nothing, and is asked again;
  3. batch: the 2026-09 replay (a first run from 09-21, a later one from 09-01) and a mid-month
     `end` both end with whole months, the request is month-aligned, the answer is not widened;
  4. old files: a month with no open flag costs zero requests and its bytes do not change, whatever
     hole it has, single or batch; a backtest moving `start` before the cache still merges as
     before, and whole-month alignment adds nothing to a final month on disk;
  5. live: fetch_kline's last bar inside the grace is the one it is without this rule; a batch
     tick survives a failed window; inside the grace a listing month costs a tail request; past
     the grace an answer short of the month's end does not close the month for a day;
  6. all 14 crypto prefixes are listed, a closed and an open month read back together, series
     not listed stay untouched.
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


def is_open(path):
    return bool((d._read_schema(path).metadata or {}).get(b"blave_month_open"))


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


def seed_month(prefix, params, idx, written, value=1.0, open_=False):
    mdir = d._monthly_cache_dir(prefix, params)
    mdir.mkdir(parents=True, exist_ok=True)
    idx = pd.DatetimeIndex(idx)
    path = mdir / f"{idx[0]:%Y-%m}.parquet"
    d._atomic_to_parquet(pd.DataFrame({"alpha": value}, index=idx), path, d._OPEN_META if open_ else None)
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
    check(is_open(path), f"{prefix}: that read settles nothing")
    src.published = keep
    src.calls.clear()
    out = run(datetime(2026, 11, 1, 0, 12))
    check(LAST in out.index, f"{prefix}: a read inside the grace gets the closing bar")
    check(src.calls[0] == ("2026-10-31", "2026-11-01"), f"{prefix}: …asking for the tail, not the month ({src.calls[0]})")
    check(is_open(path), f"{prefix}: …and still settles nothing")
    src.calls.clear()
    run(datetime(2026, 11, 1, 0, 31))
    check(src.calls[0] == ("2026-10-31", "2026-11-01") and not is_open(path),
          f"{prefix}: the first read after the grace asks for the tail once more and closes it ({src.calls[0]})")
    src.calls.clear()
    run(datetime(2026, 11, 1, 1, 5))
    run(datetime(2026, 11, 9, 1, 5))
    check(not any(s < "2026-11-01" for s, _ in src.calls), f"{prefix}: never asked again ({src.calls})")

fresh()
params = {"symbol": "BTCUSDT", "period": "1h"}
src = Source("2026-11-01 00:00", value=lambda t: 3.0)
path = seed_month("kline3", params, bars("2026-10-01", "2026-11-01", "1h"), datetime(2026, 11, 1, 0, 0, 5), open_=True)
out = at(datetime(2026, 11, 1, 0, 5), d._extend_cache_monthly, "kline3", params, src, "2026-10-01", None)
check(out.loc[LAST, "alpha"] == 3.0, "a bar cached while forming is replaced by the final one")

# 2. a re-read that fails
fresh()
params = {"symbol": "ETHUSDT", "period": "1h"}
src = Source("2026-11-01 00:00")
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-31 23:00", "1h"), datetime(2026, 11, 1, 0, 1), open_=True)
run = lambda when: at(when, d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
src.mode = "raise"
out = run(datetime(2026, 11, 1, 0, 40))
check(len(out) and is_open(path), "a failed re-read serves the cache and closes nothing")
src.mode = "empty"
run(datetime(2026, 11, 1, 1, 40))
check(is_open(path), "an empty 200 for a month with rows closes nothing")
src.mode = "ok"
out = run(datetime(2026, 11, 1, 2, 40))
check(LAST in out.index and not is_open(path), "the next read fills it and closes it")

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
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-20", "1h"), datetime(2026, 11, 1, 1), open_=True)
src.mode = "empty"
run(datetime(2026, 11, 3, 2))
check(not is_open(path), "a day past the mark an empty answer is believed: a dead series stops asking")
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
check(api.calls[0][0] == "2026-10-31" and not is_open(oct_file), f"batch: past the grace one more tail read closes it ({api.calls})")
api.calls = []
hourly(datetime(2026, 11, 1, 1, 5))
check(api.calls[0][0] == "2026-11-01", f"batch: then back to this month ({api.calls})")

# 4. old files
def holes_on_disk():
    fresh()
    params = {"symbol": "SOLUSDT", "period": "1h"}
    gap = bars("2026-08-01", "2026-09-01", "1h")
    return params, [
        seed_month("kline3", params, gap[(gap < "2026-08-10") | (gap >= "2026-08-12")], datetime(2026, 9, 5)),   # inside
        seed_month("kline3", params, bars("2026-09-21", "2026-10-01", "1h"), datetime(2026, 10, 3)),             # half month
        seed_month("kline3", params, bars("2026-10-01", "2026-10-31 22:00", "1h"), datetime(2026, 11, 1, 0, 1)),  # tail, rollover
    ]


for when, label in ((datetime(2026, 11, 2, 3), "after its grace"), (datetime(2026, 11, 1, 0, 12), "inside the grace")):
    params, files = holes_on_disk()
    before = [(p.read_bytes(), p.stat().st_mtime_ns) for p in files]
    src = Source("2026-11-02")
    out = at(when, d._extend_cache_monthly, "kline3", params, src, "2026-08-01", None)
    check(not any(s < "2026-11-01" for s, _ in src.calls), f"old files, {label}: zero requests for them ({src.calls})")
    check(before == [(p.read_bytes(), p.stat().st_mtime_ns) for p in files], f"old files, {label}: bytes and mtime unchanged")
    check(pd.Timestamp("2026-09-10") not in out.index and pd.Timestamp("2026-10-31 23:00") not in out.index,
          f"old files, {label}: the holes are still there")

for name, freq in (("funding_rate", "8h"), ("oi_history", "1h"), ("whale_hunter", "5min")):
    fresh()
    params = {"symbol": "ADAUSDT", "period": freq}
    path = seed_month(name, params, bars("2026-09-01", "2026-09-30", freq), datetime(2026, 10, 2))
    raw = path.read_bytes()
    src = Source("2026-11-02", freq=freq)
    at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, name, params, src, "2026-09-01", "2026-09-30")
    check(not src.calls and raw == path.read_bytes(), f"{name}: an old month with a tail hole is left alone ({src.calls})")

fresh()
for sym in SYMS:
    seed_month("kline3_1d", {"id": sym}, bars("2026-09-21", "2026-10-01", "1D"), datetime(2026, 10, 3))
    seed_month("kline3_1d", {"id": sym}, bars("2026-10-01", "2026-10-30", "1D"), datetime(2026, 11, 1, 0, 1))
files = sorted(d._CACHE_DIR.rglob("*.parquet"))
raw = [p.read_bytes() for p in files]
api = Api(SYMS, last="2026-11-02")
d._retry_get = api.get
go = lambda when: at(when, d.fetch_kline_batch, SYMS, "1d", "2026-09-01", None, {})
for when in (datetime(2026, 11, 1, 0, 12), datetime(2026, 11, 2, 3)):
    api.calls = []
    out = go(when)
    check(all(c[0] >= "2026-11-01" for c in api.calls), f"batch: old files cost no request at {when:%m-%d %H:%M} ({api.calls})")
check(raw == [p.read_bytes() for p in files], "batch: old files keep their bytes")
check(len(d._read_parquet(d._monthly_cache_dir("kline3_1d", {"id": "BTCUSDT"}) / "2026-09.parquet")) == 10,
      "batch: the half month stays half")

fresh()
for sym in SYMS:
    seed_month("kline3_1d", {"id": sym}, bars("2026-09-21", "2026-10-01", "1D"), datetime(2026, 10, 3))
api = Api(SYMS, last="2026-10-05")
d._retry_get = api.get
out = at(datetime(2026, 10, 5, 3), d.fetch_kline_batch, SYMS, "1d", "2026-08-20", None, {})
sep = d._monthly_cache_dir("kline3_1d", {"id": "BTCUSDT"}) / "2026-09.parquet"
check(len(d._read_parquet(sep)) == 30, "a backtest moving `start` before the cache still merges into the old month, as before")
aug = d._monthly_cache_dir("kline3_1d", {"id": "BTCUSDT"}) / "2026-08.parquet"
check(len(d._read_parquet(aug)) == 31, "…and a month it creates is whole")

fresh()
idx = bars("2026-08-20", "2026-09-01", "1D")
for sym in SYMS:
    path = seed_month("kline3_1d", {"id": sym}, idx, datetime(2026, 9, 5))
    seed_month("kline3_1d", {"id": sym}, bars("2026-09-01", "2026-09-20", "1D"), datetime(2026, 9, 18))   # mid-month: re-fetched
api = Api(SYMS, last="2026-10-05")
d._retry_get = api.get
api.fail_before = "2026-10-01"                        # the prefetch fails, the ids fall to phase 2 …
first_get = api.get
def only_prefetch_fails(url, **kw):
    r = first_get(url, **kw)
    api.fail_before = None
    return r
d._retry_get = only_prefetch_fails
at(datetime(2026, 10, 5, 3), d.fetch_kline_batch, SYMS, "1d", "2026-08-25", None, {})
check(len(d._read_parquet(path)) == 12, "whole-month alignment adds nothing to a final month on disk (asked from 08-25, it starts 08-20)")
d._retry_get = api.get

# 5. live bar boundary
fresh()
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

# a live batch tick and a failing window: the tail shares this month's request, so it falls to phase 2 as before
fresh()
for sym in SYMS:
    seed_month("kline3_1h", {"id": sym}, bars("2026-10-01", "2026-10-31 22:00", "1h"), datetime(2026, 11, 1, 0, 1), open_=True)
    seed_month("kline3_1h", {"id": sym}, bars("2026-11-01", "2026-11-01 01:00", "1h"), datetime(2026, 11, 1, 1, 1), open_=True)
api = Api(SYMS, freq="1h", last="2026-11-01 02:00")
api.fail_before = "2026-11-01"
def fail_once(url, **kw):
    r = api.get(url, **kw)
    api.fail_before = None
    return r
d._retry_get = fail_once
d._live_feeds += 1
out = at(datetime(2026, 11, 1, 1, 30), d.fetch_kline_batch, SYMS, "1h", "2026-10-01", None, {})
d._live_feeds -= 1
d._retry_get = api.get
check(set(out) == set(SYMS) and LAST in d._read_parquet(d._monthly_cache_dir("kline3_1h", {"id": "BTCUSDT"}) / "2026-10.parquet").index,
      "a failed window on a live tick falls to the batch retry and the tick goes on")

fresh()
for ym in ("2026-09", "2026-10"):
    nxt = d._next_month(ym)
    seed_month("kline3_1h", {"id": "BTCUSDT"}, bars(f"{ym}-01", f"{nxt}-01", "1h"), datetime(int(nxt[:4]), int(nxt[5:7]), 1, 0, 1), open_=True)
api = Api(["BTCUSDT"], freq="1h", last="2026-12-02")
d._retry_get = api.get
out = at(datetime(2026, 12, 2, 4), d.fetch_kline_batch, ["BTCUSDT"], "1h", "2026-09-01", None, {})
check(len(out["BTCUSDT"]) and not any(c[0] == "2026-09-01" for c in api.calls),
      f"an open month older than the batch's window just waits: no whole-range re-fetch ({api.calls})")

# inside the grace
fresh()
BOTH = ["BTCUSDT", "NEWUSDT"]
seed_month("kline3_5min", {"id": "BTCUSDT"}, bars("2026-10-01", "2026-10-31 23:00", "5min"), datetime(2026, 11, 1, 0, 1), open_=True)
seed_month("kline3_5min", {"id": "NEWUSDT"}, bars("2026-10-20", "2026-10-31 23:00", "5min"), datetime(2026, 11, 1, 0, 1), open_=True)
api = Api(BOTH, freq="5min", last="2026-11-01 00:10")
d._retry_get = api.get
at(datetime(2026, 11, 1, 0, 12), d.fetch_kline_batch, BOTH, "5min", "2026-10-01", None, {})
check(api.calls[0][0] == "2026-10-31", f"a listing month in the batch does not widen the window ({api.calls[0]})")

# past the grace, api still behind
fresh()
params = {"symbol": "LINKUSDT", "period": "1h"}
src = Source("2026-10-31 21:00")
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-31 21:00", "1h"), datetime(2026, 11, 1, 0, 1), open_=True)
run = lambda when: at(when, d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
run(datetime(2026, 11, 1, 0, 31))
check(is_open(path), "past the grace an answer short of the month's end closes nothing")
src.published = "2026-11-01"
out = run(datetime(2026, 11, 1, 1, 5))
check(LAST in out.index and not is_open(path), "…the api catches up, the bar lands, the month closes")
fresh()
src = Source("2026-10-20")
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-20", "1h"), datetime(2026, 11, 1, 0, 1), open_=True)
run(datetime(2026, 11, 1, 0, 31))
check(is_open(path), "a series that stopped mid-month is doubted first")
run(datetime(2026, 11, 2, 1))
check(not is_open(path), "…and believed a day later")

# an open month whose first read comes after the grace: the machine was off, and the api is behind
fresh()
params = {"symbol": "UNIUSDT", "period": "1h"}
src = Source("2026-10-31 21:00")
run = lambda when: at(when, d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
run(datetime(2026, 10, 31, 20, 5))
path = d._monthly_cache_dir("whale_hunter", params) / "2026-10.parquet"
check(is_open(path), "a month written by this rule while current is open")
run(datetime(2026, 11, 1, 1))
check(is_open(path), "a first read after the grace, api still short, keeps it open")
src.published = "2026-11-01"
out = run(datetime(2026, 11, 1, 2))
check(LAST in out.index and not is_open(path), "…the next read gets the closing bar and closes it")

# the same first read on an old file: it completes as it always did and stays final
fresh()
src = Source("2026-10-31 21:00")
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-20", "1h"), datetime(2026, 10, 20))
run(datetime(2026, 11, 1, 1))
check(not is_open(path) and len(d._read_parquet(path)) == 741, "an old file's completing read does not open it")

# a cold read of a finished month, api short
fresh()
src = Source("2026-10-31 21:00")
at(datetime(2026, 11, 1, 1), d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", "2026-10-31")
path = d._monthly_cache_dir("whale_hunter", params) / "2026-10.parquet"
check(is_open(path), "a cold read that stops short of the month's end stays open")

# a batch fetch landing on an open month, api short
fresh()
seed_month("kline3_1h", {"id": "BTCUSDT"}, bars("2026-10-01", "2026-10-31", "1h"), datetime(2026, 11, 1, 0, 40), open_=True)
Clock.at = datetime(2026, 11, 1, 1)
d._save_monthly("kline3_1h", {"id": "BTCUSDT"}, pd.DataFrame({"alpha": 2.0}, index=bars("2026-10-31", "2026-10-31 21:00", "1h")))
check(is_open(d._monthly_cache_dir("kline3_1h", {"id": "BTCUSDT"}) / "2026-10.parquet"), "_save_monthly keeps an open month open while its tail is short")

# whole-month alignment that brings nothing inside the caller's range leaves a final file alone
fresh()
path = seed_month("kline3_1h", {"id": "BTCUSDT"}, bars("2026-08-20", "2026-09-01", "1h"), datetime(2026, 9, 5))
stamp_ns = path.stat().st_mtime_ns
Clock.at = datetime(2026, 11, 2, 3)
d._save_monthly("kline3_1h", {"id": "BTCUSDT"}, pd.DataFrame({"alpha": 2.0}, index=bars("2026-08-01", "2026-08-20", "1h")),
                (pd.Timestamp("2026-08-25"), pd.Timestamp("2026-08-26")))
check(path.stat().st_mtime_ns == stamp_ns, "_save_monthly with nothing to add does not rewrite the file")

# the threshold
one, two = bars("2026-10-01", "2026-10-31 23:00", "1h"), bars("2026-10-01", "2026-10-31 22:00", "1h")
check(d._tail_short(two, "2026-10") and d._tail_short(one, "2026-10"), "one or two bars short at the end are short")
check(not d._tail_short(bars("2026-10-01", "2026-11-01", "1h"), "2026-10"), "a whole month is not")

# a re-read that cannot be saved
fresh()
params = {"symbol": "ATOMUSDT", "period": "1h"}
path = seed_month("whale_hunter", params, bars("2026-10-01", "2026-10-31 23:00", "1h"), datetime(2026, 11, 1, 0, 1), open_=True)
src = Source("2026-11-01")
real_write = d._atomic_to_parquet
def locked(df, p, meta=None):
    if p == path:
        raise PermissionError("in use")
    return real_write(df, p, meta)
d._atomic_to_parquet = locked
out = at(datetime(2026, 11, 1, 0, 40), d._extend_cache_monthly, "whale_hunter", params, src, "2026-10-01", None)
d._atomic_to_parquet = real_write
check(len(out) and is_open(path), "a re-read that cannot be saved does not fail the call, and the month stays open")

# what a batch stores
fresh()
api = Api(SYMS, freq="1h", last="2026-11-01 00:10")
d._retry_get = api.get
at(datetime(2026, 11, 1, 0, 12), d.fetch_kline_batch, SYMS, "1h", "2026-09-01", None, {})
mdir = d._monthly_cache_dir("kline3_1h", {"id": "BTCUSDT"})
check(not is_open(mdir / "2026-09.parquet"), "a cold batch closes a month past its grace")
check(is_open(mdir / "2026-10.parquet"), "…not one inside it")
check(is_open(mdir / "2026-11.parquet"), "…and the current month is open from its first write")

# 6. every crypto series on the clock
import re
source = Path(d.__file__).read_text(encoding="utf-8")
slugs = set(re.findall(r"_fetch_alpha\(\s*'([a-z_]+)/", source)) | set(re.findall(r"_fetch_alpha\(f'([a-z_]+)/", source))
want = slugs | {"kline3", "bingx_kline", "oi_history"}
check(len(want) == 14 and want == set(d._CRYPTO_SETTLE_PREFIXES),
      f"the 14 crypto prefixes are exactly the fetchers' ({sorted(want ^ set(d._CRYPTO_SETTLE_PREFIXES))})")
for name in sorted(want) + ["kline3_1h", "kline3_1min"]:
    check(d._settle_delay(name) == d._CRYPTO_GRACE, f"{name} is on the 30-minute clock")
for name in ("twstock_minute_1m", "twfutures3_1d", "twfutures_bav"):
    check(d._settle_delay(name) == timedelta(days=7), f"{name} keeps the 7-day clock")

# Taiwan months share the re-read path
fresh()
params = {"symbol": "TXF"}
T = "twfutures3_1m"
src = Source("2026-11-02")
src.mode = "raise"
path = seed_month(T, params, bars("2026-10-01", "2026-11-01", "1h"), datetime(2026, 11, 1, 2), open_=True)
run = lambda when: at(when, d._extend_cache_monthly, T, params, src, "2026-10-01", None)
out = run(datetime(2026, 11, 8, 2))
check(len(out) and is_open(path), "Taiwan: a failed settle read serves the cache and closes nothing")
src.mode = "empty"
run(datetime(2026, 11, 8, 2, 30))
check(is_open(path), "Taiwan: an empty answer inside eight days closes nothing")
src.mode = "ok"
run(datetime(2026, 11, 8, 3))
check(not is_open(path), "Taiwan: the next good read closes it")

# mixed files, unlisted series
fresh()
params = {"symbol": "DOTUSDT", "period": "1h"}
seed_month("kline3", params, bars("2026-08-01", "2026-09-01", "1h"), datetime(2026, 9, 1, 2))
seed_month("kline3", params, bars("2026-09-01", "2026-10-01", "1h"), datetime(2026, 10, 1, 2), open_=True)
out = pd.read_parquet([d._monthly_cache_dir("kline3", params) / f"{ym}.parquet" for ym in ("2026-08", "2026-09")])
check(len(out) == 744 + 720, "a closed and an open month read back together")

fresh()
params = {"dataset": "GLBX", "symbol": "ES"}
src = Source("2026-11-02")
path = seed_month("db_ohlcv1d", params, bars("2026-10-01", "2026-10-20", "1h"), datetime(2026, 11, 1, 0, 1))
at(datetime(2026, 11, 2, 3), d._extend_cache_monthly, "db_ohlcv1d", params, src, "2026-10-01", None)
check(("2026-10-01", "2026-11-01") not in src.calls and not is_open(path), "a series not listed is left as it was")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
