"""A Taiwan cache must not freeze last month's days the api had not published at the rollover.

Pins, on a fixed clock against in-process fakes (no network):
  1. single-file layout: a day missing at the rollover lands on a later read, whatever the
     last cached bar is; once the month has settled the delta is the plain last-bar one again;
  2. a file from before `settled`: one read from _SETTLE_HEAL_FROM fills an old seam, not the
     whole history, and it does not repeat;
  3. a request ending in a past month heals too, and a re-read short of the tail does not stamp
     the tail as fetched;
  4. batch: the re-read stays inside the prefetch window, /bulk only ever sees the 1st of last
     month, the heal goes to /batch, no id falls to the full-range phase 2, and a fixed `end`
     short of the seam stays on /bulk;
  5. monthly layout: a Taiwan month is read once more after it settles, an old file the TTL
     check keeps refreshing heals by its footer (TXF and stock minute), nothing before
     _SETTLE_HEAL_FROM does, and exchange-direct and unlisted series are left alone;
  6. _merge_meta never invents `settled`.
Run: cd blave-agent && .venv/bin/python tests/check_tw_cache_month_seam.py
"""
import os, shutil, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pandas as pd
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="twseam-"))
d._CACHE_DIR = TMP / "cache"
os.environ.pop("BLAVE_FETCH_FRESH_SINCE", None)
os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "blave"

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)


class Clock(datetime):
    at = datetime(2026, 11, 1, 2, 0, 0)

    @classmethod
    def utcnow(cls):
        return cls.at

    @classmethod
    def now(cls, tz=None):
        return cls.at if tz is None else cls.at.replace(tzinfo=timezone.utc).astimezone(tz)


d.datetime = Clock


def days(start, end):
    return [x.strftime("%Y-%m-%d") for x in pd.bdate_range(start, end)]


class Source:
    """raw_fn(start, end): rows up to `published`, end exclusive like the cache's windows."""
    def __init__(self, published, skip=()):
        self.published, self.skip, self.calls = published, set(skip), []

    def __call__(self, s, e):
        self.calls.append((s, e))
        idx = [x for x in days("2025-12-01", "2026-12-31")
               if s <= x < e and x <= self.published and x not in self.skip]
        return pd.DataFrame({"Close": [float(x[-2:]) for x in idx]}, index=pd.DatetimeIndex(idx))


def fresh_cache():
    shutil.rmtree(d._CACHE_DIR, ignore_errors=True)
    d._CACHE_DIR.mkdir(parents=True)


def cached_days(prefix, params):
    return [x.strftime("%Y-%m-%d") for x in d._read_single(prefix, params)[0].index]


P, ID = "twstock_inst", {"id": "2330"}

# 1. api late at the rollover
fresh_cache()
src = Source("2026-10-28")
Clock.at = datetime(2026, 11, 1, 2)
d._extend_cache_monthly(P, ID, src, "2026-09-01", None)
src.published = "2026-11-03"                         # Oct 29, 30 and Nov 2, 3 all land together
Clock.at = datetime(2026, 11, 3, 12)
out = d._extend_cache_monthly(P, ID, src, "2026-09-01", None)
got = [x.strftime("%Y-%m-%d") for x in out.index]
check("2026-10-29" in got and "2026-10-30" in got and "2026-11-03" in got,
      f"the days missing at the rollover land on a later read ({got[-5:]})")
check(src.calls[-1][0] == "2026-10-01", f"the re-read starts at last month's 1st, not at the history ({src.calls[-1]})")

src2 = Source("2026-11-04", skip={"2026-10-30"})      # the last bar is past the hole already
fresh_cache()
Clock.at = datetime(2026, 11, 3, 12)
d._extend_cache_monthly(P, ID, src2, "2026-09-01", None)
src2.skip = set()
Clock.at = datetime(2026, 11, 4, 12)
d._extend_cache_monthly(P, ID, src2, "2026-09-01", None)
check("2026-10-30" in cached_days(P, ID), "a hole behind the last cached bar is filled too")

for at, want in ((datetime(2026, 11, 7, 23), "2026-10-01"), (datetime(2026, 11, 8, 1), "2026-10-01")):
    Clock.at = at
    d._extend_cache_monthly(P, ID, src2, "2026-09-01", None)
    check(src2.calls[-1][0] == want, f"still inside the week at {at:%m-%d %H:%M}, or its closing read ({src2.calls[-1]})")
Clock.at = datetime(2026, 11, 9, 1)
n = len(src2.calls)
d._extend_cache_monthly(P, ID, src2, "2026-09-01", None)
check(len(src2.calls) == n + 1 and src2.calls[-1][0] == "2026-11-04",
      f"once settled the delta is the plain last-bar one ({src2.calls[n:]})")
check(d._read_single_meta(P, ID)["settled"] == "2026-10", "`settled` moved to last month")

# 2. a file from before `settled`
fresh_cache()
Clock.at = datetime(2026, 11, 20, 2)
hist = [x for x in days("2026-01-01", "2026-11-19") if x not in ("2026-09-29", "2026-09-30")]
frame = pd.DataFrame({"Close": 1.0}, index=pd.DatetimeIndex(hist))
d._write_single(P, ID, frame, {"from": "2026-01", "to": "2026-11", "tail_fetched_at": "2026-11-19T02:00:00"})
src = Source("2026-11-20")
d._extend_cache_monthly(P, ID, src, "2026-01-01", None)
check(src.calls == [("2026-08-01", "2026-11-21")], f"one read from the layout's first month, not from 2026-01 ({src.calls})")
check("2026-09-30" in cached_days(P, ID), "an old seam's hole is filled without clearing the cache")
src.calls.clear()
d._extend_cache_monthly(P, ID, src, "2026-01-01", None)
check(src.calls[0][0] >= "2026-11-01", f"…once ({src.calls})")

# 3. a request that ends in a past month
fresh_cache()
Clock.at = datetime(2026, 11, 1, 2)
src = Source("2026-10-28")
d._extend_cache_monthly(P, ID, src, "2026-09-01", "2026-10-31")
src.published = "2026-11-03"
Clock.at = datetime(2026, 11, 3, 12)
d._extend_cache_monthly(P, ID, src, "2026-09-01", "2026-10-31")
check("2026-10-30" in cached_days(P, ID), "a fixed end in last month heals the seam as well")

fresh_cache()
Clock.at = datetime(2026, 11, 20, 2)
hist = days("2026-01-01", "2026-10-20")
d._write_single(P, ID, pd.DataFrame({"Close": 1.0}, index=pd.DatetimeIndex(hist)),
                {"from": "2026-01", "to": "2026-10", "tail_fetched_at": "2026-10-20T10:00:00"})
src = Source("2026-11-20")
d._extend_cache_monthly(P, ID, src, "2026-01-01", "2026-08-31")
meta = d._read_single_meta(P, ID)
check(src.calls == [("2026-08-01", "2026-09-01")] and meta["tail_fetched_at"] == "2026-10-20T10:00:00",
      f"a seam read short of the tail leaves the tail stamp alone ({src.calls}, {meta})")
check(meta.get("settled") == "2026-08", f"…and settles only what it read ({meta.get('settled')})")

# 4. batch
class R:
    def __init__(self, body): self._b = body
    def json(self): return self._b


class Api:
    def __init__(self, published, ids, skip=()):
        self.published, self.ids, self.skip, self.calls = published, ids, set(skip), []

    def _rows(self, sid, start, end):
        return [{"date": x, "stock_id": sid, "open": 1.0, "close": 2.0, "high": 2.0, "low": 1.0,
                 "volume": 1, "spread": 0, "turnover_value": 1, "turnover_count": 1}
                for x in days("2026-01-01", "2026-12-31")
                if start <= x <= (end or "9999") and x <= self.published and x not in self.skip]

    def get(self, url, **kw):
        p = kw["params"]
        kind = url.split("/")[-2]
        self.calls.append((kind, p["start"]))
        ids = self.ids if kind == "bulk" else p["stock_ids"].split(",")
        body = {"data": {sid: rows for sid in ids for rows in [self._rows(sid, p["start"], p["end"])] if rows}}
        return R({**body, "stock_ids": self.ids, "failed": []} if kind == "bulk" else {**body, "failed": []})


IDS = [str(1100 + i) for i in range(450)]
fresh_cache()
Clock.at = datetime(2026, 11, 1, 2)
api = Api("2026-10-28", IDS)
d._retry_get = api.get
d.fetch_twstock_price_adj_batch(IDS, "2026-09-01", None, {})
api.published, api.calls = "2026-11-03", []
Clock.at = datetime(2026, 11, 3, 12)
out = d.fetch_twstock_price_adj_batch(IDS, "2026-09-01", None, {})
check(api.calls == [("bulk", "2026-10-01")], f"whole market: one /bulk from last month's 1st, nothing else ({api.calls[:3]})")
check("2026-10-30" in out["1105"].index.strftime("%Y-%m-%d"), "…and the missing day is in the frame")

api.calls = []
Clock.at = datetime(2026, 11, 20, 2)
api.published = "2026-11-20"
for sid in IDS:                                       # as 0.1.40 wrote them
    df, meta = d._read_single("twstock_price3", {"id": sid})
    meta.pop("settled")
    d._write_single("twstock_price3", {"id": sid}, df, meta)
out = d.fetch_twstock_price_adj_batch(IDS, "2026-09-01", None, {})
check(len(api.calls) == 9 and set(api.calls) == {("batch", "2026-09-01")}, f"the heal goes to /batch in one pass ({api.calls[:2]}, {len(api.calls)} calls)")
api.calls = []
d.fetch_twstock_price_adj_batch(IDS, "2026-09-01", None, {})
check(api.calls == [("bulk", "2026-11-01")], f"…and the next tick is the plain /bulk ({api.calls[:3]})")

def strip_settled():                                  # as 0.1.40 wrote them
    for sid in IDS:
        df, meta = d._read_single("twstock_price3", {"id": sid})
        meta.pop("settled")
        d._write_single("twstock_price3", {"id": sid}, df, meta)


fresh_cache()
Clock.at = datetime(2026, 11, 20, 2)
api = Api("2026-11-20", IDS)
d._retry_get = api.get
d.fetch_twstock_price_adj_batch(IDS, "2026-06-01", None, {})
strip_settled()
for n in (1, 2):
    api.calls = []
    d.fetch_twstock_price_adj_batch(IDS, "2026-06-01", "2026-07-31", {})
    check(api.calls == [("bulk", "2026-11-01")], f"a fixed end before the seam: /bulk only, call {n} ({api.calls[:2]})")
api.calls = []
d.fetch_twstock_price_adj_batch(IDS, "2026-06-01", "2026-08-31", {})
check(len(api.calls) == 9 and set(api.calls) == {("batch", "2026-08-01")},
      f"a fixed end reaching the seam reads it on /batch ({api.calls[:2]}, {len(api.calls)} calls)")
api.calls = []
d.fetch_twstock_price_adj_batch(IDS, "2026-06-01", "2026-08-31", {})
check(api.calls == [("bulk", "2026-11-01")], f"…and the same call next time is /bulk only ({api.calls[:2]})")

# 5. monthly layout
def stamp(path, at):
    ts = at.replace(tzinfo=timezone.utc).timestamp()
    os.utime(path, (ts, ts))


fresh_cache()
Clock.at = datetime(2026, 11, 1, 2)
src = Source("2026-10-28")
M, MID = "twfutures_bav", {"symbol": "TXF"}
d._extend_cache_monthly(M, MID, src, "2026-09-01", None)
oct_file = d._monthly_cache_dir(M, MID) / "2026-10.parquet"
sep_file = d._monthly_cache_dir(M, MID) / "2026-09.parquet"
stamp(sep_file, datetime(2026, 10, 25))
stamp(oct_file, Clock.at)
src.published = "2026-11-03"
src.calls.clear()
Clock.at = datetime(2026, 11, 3, 12)
d._extend_cache_monthly(M, MID, src, "2026-09-01", None)
check(not any(s < "2026-11-01" for s, _ in src.calls), f"inside the week nothing past is re-read ({src.calls})")
Clock.at = datetime(2026, 11, 8, 12)
src.calls.clear()
out = d._extend_cache_monthly(M, MID, src, "2026-09-01", None)
got = out.index.strftime("%Y-%m-%d")
check(("2026-10-01", "2026-11-01") in src.calls and "2026-10-30" in got,
      f"a week after the month ended it is read once more and the days land ({src.calls})")
stamp(oct_file, Clock.at)
src.calls.clear()
d._extend_cache_monthly(M, MID, src, "2026-09-01", None)
check(("2026-10-01", "2026-11-01") not in src.calls, f"…once ({src.calls})")

fresh_cache()
Clock.at = datetime(2026, 11, 1, 2)
src = Source("2026-10-28")
T, TID = "twfutures3_1d", {"symbol": "TXF"}
d._extend_cache_monthly(T, TID, src, "2026-10-01", None, empty_marker_ttl_hours=24)
path = d._monthly_cache_dir(T, TID) / "2026-10.parquet"
stamp(path, Clock.at)
real_stale = d._stale_incomplete_month
seen = []
d._stale_incomplete_month = lambda p, ttl, ym, edge_days=15: seen.append(ym) or stamp(p, Clock.at) or False
Clock.at = datetime(2026, 11, 3, 12)
d._extend_cache_monthly(T, TID, src, "2026-10-01", None, empty_marker_ttl_hours=24)   # refreshes inside the week
Clock.at = datetime(2026, 11, 9, 12)
src.calls.clear()
d._extend_cache_monthly(T, TID, src, "2026-10-01", None, empty_marker_ttl_hours=24)
d._stale_incomplete_month = real_stale
check(seen and ("2026-10-01", "2026-11-01") in src.calls, f"the TTL check's mtime refresh does not hide it ({src.calls})")

for label, prefix, params in (("TXF 1m", "twfutures3_1m", {"symbol": "TXF"}),
                              ("stock 5m", "twstock_minute_5m", {"id": "2330", "adj": 0})):
    fresh_cache()                                     # as 0.1.40 left them: no flag, mtime refreshed daily
    mdir = d._monthly_cache_dir(prefix, params)
    mdir.mkdir(parents=True)
    Clock.at = datetime(2026, 11, 20, 2)
    for ym, last in (("2026-06", "2026-06-30"), ("2026-07", "2026-07-31"), ("2026-08", "2026-08-31"),
                     ("2026-09", "2026-09-28"), ("2026-10", "2026-10-30")):
        idx = pd.DatetimeIndex(days(f"{ym}-01", last))
        pd.DataFrame({"Close": 1.0}, index=idx).to_parquet(mdir / f"{ym}.parquet")
        stamp(mdir / f"{ym}.parquet", datetime(2026, 11, 19, 2))
    src = Source("2026-11-20")
    d._stale_incomplete_month = lambda p, ttl, ym, edge_days=15: False
    d._extend_cache_monthly(prefix, params, src, "2026-06-01", None, empty_marker_ttl_hours=24)
    sep = pd.read_parquet(mdir / "2026-09.parquet")
    check(("2026-08-01", "2026-11-01") in src.calls and pd.Timestamp("2026-09-30") in sep.index,
          f"{label}: an old month past the mark, mtime refreshed, heals ({src.calls})")
    check(not any(s < "2026-08" for s, _ in src.calls), f"{label}: a month before the heal floor is left alone")
    src.calls.clear()
    stamp(mdir / "2026-09.parquet", datetime(2026, 11, 19, 2))
    d._extend_cache_monthly(prefix, params, src, "2026-06-01", None, empty_marker_ttl_hours=24)
    d._stale_incomplete_month = real_stale
    check(not any(s < "2026-11" for s, _ in src.calls), f"{label}: …once, whatever the mtime says ({src.calls})")

fresh_cache()
Clock.at = datetime(2026, 11, 20, 2)
src = Source("2026-11-20")
d._extend_cache_monthly(T, TID, src, "2026-09-01", None, empty_marker_ttl_hours=24)
src.calls.clear()
d._extend_cache_monthly(T, TID, src, "2026-09-01", None, empty_marker_ttl_hours=24)
check(not any(s < "2026-11" for s, _ in src.calls), f"a month first read after its mark needs no second read ({src.calls})")

fresh_cache()
Clock.at = datetime(2026, 11, 1, 2)
src = Source("2026-10-28")
K, KID = "db_ohlcv1d", {"dataset": "GLBX", "symbol": "ES"}
d._extend_cache_monthly(K, KID, src, "2026-10-01", None)
stamp(d._monthly_cache_dir(K, KID) / "2026-10.parquet", Clock.at)
Clock.at = datetime(2026, 11, 9, 12)
src.calls.clear()
d._extend_cache_monthly(K, KID, src, "2026-10-01", None)
check(("2026-10-01", "2026-11-01") not in src.calls, f"a series on no settle clock is not re-read ({src.calls})")

fresh_cache()
Clock.at = datetime(2026, 11, 1, 2)
src = Source("2026-10-28")
X, XID = "twmarket_public", {"kind": "index"}
d._extend_cache_monthly(X, XID, src, "2026-10-01", None)
stamp(d._monthly_cache_dir(X, XID) / "2026-10.parquet", Clock.at)
Clock.at = datetime(2026, 11, 9, 12)
src.calls.clear()
d._extend_cache_monthly(X, XID, src, "2026-10-01", None)
check(("2026-10-01", "2026-11-01") not in src.calls, f"an exchange-direct month is not re-read ({src.calls})")

# 6. coverage meta
a = {"from": "2026-01", "to": "2026-10", "tail_fetched_at": "2026-11-01T00:00:00"}
b = {"from": "2026-09", "to": "2026-11", "tail_fetched_at": "2026-11-02T00:00:00", "settled": "2026-09"}
check("settled" not in d._merge_meta(a, b), "merging with a file that has no `settled` leaves it unknown")
check(d._merge_meta({**a, "settled": "2026-08"}, b)["settled"] == "2026-08", "merging keeps the earlier `settled`")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
