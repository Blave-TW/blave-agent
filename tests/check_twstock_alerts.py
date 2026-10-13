"""fetch_twstock_alerts / twstock_disposal_mask: the wrapper around /studio/market/twstock/alerts.

Pins: a whole-market range longer than 366 days goes out as one request per (kind, calendar
year), each ≤ 366 inclusive days, never with a stock_id; a disposal straddling a year boundary
(in both years' answers) comes back once; the api's range semantics hold locally (disposal =
period overlap, notice = announcement date; market filtered locally); the mask is True on the
period's first and last day and False the day before / after, overlapping periods OR together,
an unknown id is all False; an empty answer is an empty frame and an all-False mask; finished
years are served from the cache, the current year again after its 1 h; with stock_id it is one
request for the whole history; the feed timing is the next day 07:30 Taipei.
No network. Run: cd blave-agent && .venv/bin/python tests/check_twstock_alerts.py
"""
import os, shutil, sys, tempfile, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pandas as pd
import requests
from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="twalerts-"))
d._CACHE_DIR = TMP

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

Y = pd.Timestamp.now(tz="Asia/Taipei").year
def row(date, sid, market, kind, start=None, end=None):
    return {"date": date, "stock_id": sid, "stock_name": "n", "market": market, "kind": kind, "count": 1,
            "start": start, "end": end, "condition": "c", "measure": "第一次處置" if kind == "disposal" else None,
            "match_minutes": 5 if kind == "disposal" else None, "reason": "r", "close": None, "pe": None}

STORE = [
    row("2014-12-22", "1111", "twse", "disposal", "2014-12-23", "2015-01-06"),   # straddles 2014/2015
    row("2015-03-02", "2222", "tpex", "disposal", "2015-03-03", "2015-03-09"),
    row("2015-03-06", "2222", "tpex", "disposal", "2015-03-09", "2015-03-16"),   # overlaps the one above
    row("2015-06-01", "1111", "twse", "notice"),
    row("2016-02-01", "3333", "tpex", "notice"),
    row(f"{Y}-01-05", "4444", "twse", "disposal", f"{Y}-01-06", f"{Y}-01-12"),
]

calls = []
class _R:
    def __init__(self, body): self._b = body
    def json(self): return self._b

def fake_api(url, **kw):
    """The api's query semantics (tw/twstock/alerts.py query + routes.py get_twstock_alerts)."""
    p = dict(kw["params"]); calls.append((url, p))
    lo, hi = p["start"], p["end"]
    if "stock_id" not in p and (pd.Timestamp(hi) - pd.Timestamp(lo)).days + 1 > 366:
        class _Resp: status_code = 400
        raise requests.HTTPError("400 — range > 366 days without stock_id", response=_Resp())
    out = [r for r in STORE
           if (r["kind"] == "disposal" and r["start"] <= hi and r["end"] >= lo)
           or (r["kind"] == "notice" and lo <= r["date"] <= hi)]
    out = [r for r in out if p.get("kind") in (None, r["kind"]) and p.get("stock_id") in (None, r["stock_id"])]
    return _R({"start": lo, "end": hi, "data": out})

d._retry_get = fake_api

# 1. three whole-market years → one request per (kind, year), each ≤ 366 days, no stock_id
df = d.fetch_twstock_alerts({}, start="2014-01-01", end="2016-12-31")
spans = [(pd.Timestamp(p["end"]) - pd.Timestamp(p["start"])).days + 1 for _, p in calls]
check(len(calls) == 6 and max(spans) <= 366, f"3 years × 2 kinds → 6 requests of ≤ 366 days ({len(calls)}, max {max(spans)})")
check(all(u.endswith("/studio/market/twstock/alerts") for u, _ in calls), "requests go to /studio/market/twstock/alerts")
check(all("stock_id" not in p and p["kind"] in ("disposal", "notice") for _, p in calls), "kind sent, no stock_id")

# 2. the straddling disposal is in both 2014's and 2015's answers, once in the result
straddle = df[(df["stock_id"] == "1111") & (df["kind"] == "disposal")]
check(len(straddle) == 1, f"year-boundary disposal returned once ({len(straddle)})")
check(len(df) == 5, f"5 announcements in 2014–2016 ({len(df)})")

# 3. frame shape: index = announcement date; start / end Timestamps; NaT on notices
check(df.index.name == "date" and isinstance(df.index, pd.DatetimeIndex), "index = announcement date")
check(df.index.is_monotonic_increasing, "rows sorted by announcement date")
note = df[df["kind"] == "notice"].iloc[0]
check(pd.isna(note["start"]) and pd.isna(note["match_minutes"]), "notice: start NaT, match_minutes <NA>")
check(straddle["end"].iloc[0] == pd.Timestamp("2015-01-06"), "disposal end parsed as a Timestamp")

# 4. local range semantics from the cache (no request): overlap for disposals, date for notices
calls.clear()
jan = d.fetch_twstock_alerts({}, start="2015-01-06", end="2015-01-06")
check(not calls, "finished years served from the cache")
two_days = time.time() - 2 * 86400
for f in TMP.glob("twstock_alerts_y_*_2015.parquet"):
    os.utime(f, (two_days, two_days))
d.fetch_twstock_alerts({}, start="2015-01-06", end="2015-01-06")
check(not calls, "a finished year written after Feb 1 of the next year is kept past the 1 h TTL")
check(list(jan["stock_id"]) == ["1111"], "a disposal whose last day is the range start is included")
after = d.fetch_twstock_alerts({}, start="2015-01-07", end="2015-01-07")
check(after.empty, "the day after a disposal's end → not included")
junn = d.fetch_twstock_alerts({}, start="2015-05-31", end="2015-06-01", kind="notice", market="twse")
check(list(junn["stock_id"]) == ["1111"] and not d.fetch_twstock_alerts({}, start="2015-05-31", end="2015-06-01", market="tpex").shape[0],
      "notice matched by announcement date; market filtered locally")

# 5. mask boundaries
dates = pd.date_range("2015-03-02", "2015-03-17", freq="D")
m = d.twstock_disposal_mask(["2222", "1111", "9999"], dates, {})
on = m["2222"]
check(not on[pd.Timestamp("2015-03-02")] and on[pd.Timestamp("2015-03-03")], "mask: start day True, the announcement day before it False")
check(bool(on.loc["2015-03-03":"2015-03-16"].all()), "mask: overlapping periods OR together, end day of the later one True")
check(not on[pd.Timestamp("2015-03-17")], "mask: the day after end False")
check(not m["1111"].any() and not m["9999"].any(), "mask: a stock with no disposal in range / an unknown id → all False")
tz = d.twstock_disposal_mask(["2222"], pd.DatetimeIndex(["2015-03-02 16:00", "2015-03-16 16:00"], tz="UTC"), {})
check(list(tz["2222"]) == [True, False], "mask: tz-aware stamps read in Taipei (03-02 16:00 UTC = 03-03, 03-16 16:00 UTC = 03-17 Taipei)")
check(list(m.columns) == ["2222", "1111", "9999"] and m.index.equals(dates), "mask: columns = stock_ids, index = dates")

# 6. empty answers → empty frame / all-False mask
shutil.rmtree(TMP); TMP.mkdir()
saved, STORE[:] = list(STORE), []
empty = d.fetch_twstock_alerts({}, start="2010-01-01", end="2010-12-31")
check(empty.empty and list(empty.columns) == d._ALERT_COLUMNS, "empty answer → empty frame with the columns")
em = d.twstock_disposal_mask(["2222"], pd.date_range("2010-03-01", "2010-03-05"), {})
check(not em.values.any() and em.shape == (5, 1), "empty answer → all-False mask")
STORE[:] = saved

# 7. current year: cached 1 h, then refetched
shutil.rmtree(TMP); TMP.mkdir(); calls.clear()
d.fetch_twstock_alerts({}, start=f"{Y}-01-01", end=f"{Y}-01-31", kind="disposal")
d.fetch_twstock_alerts({}, start=f"{Y}-01-01", end=f"{Y}-01-31", kind="disposal")
check(len(calls) == 1, f"current year: second call within 1 h from the cache ({len(calls)} request)")
f = TMP / f"twstock_alerts_y_disposal_{Y}.parquet"
os.utime(f, (time.time() - 7200, time.time() - 7200))
d.fetch_twstock_alerts({}, start=f"{Y}-01-01", end=f"{Y}-01-31", kind="disposal")
check(len(calls) == 2, "current year: refetched once the copy is over 1 h old")
old = TMP / "twstock_alerts_y_disposal_2015.parquet"
d.fetch_twstock_alerts({}, start="2015-03-01", end="2015-03-31", kind="disposal")
os.utime(old, (pd.Timestamp("2016-01-15").timestamp(),) * 2)   # written before the api stopped refetching 2015
calls.clear()
d.fetch_twstock_alerts({}, start="2015-03-01", end="2015-03-31", kind="disposal")
check(len(calls) == 1, "a past year cached before Feb 1 of the next year is still refetched")

# 8. stock_id → one request, whole history, no range cap
calls.clear()
one = d.fetch_twstock_alerts({}, end="2026-01-01", stock_id="1111", kind="disposal")   # no start → 2001
check(len(calls) == 1 and calls[0][1]["stock_id"] == "1111" and calls[0][1]["start"] == "2001-01-01",
      "stock_id: one request from 2001")
check(len(one) == 1 and one["stock_id"].iloc[0] == "1111", "stock_id: that stock's disposals only")
check(d.fetch_twstock_alerts({}, stock_id="1111").empty and len(calls) == 1,
      "stock_id without start / end → today only (as the api), from the same cached request")

# 9. bad arguments
for kw in ({"kind": "candidate"}, {"market": "otc"}, {"start": "2015-02-01", "end": "2015-01-01"}):
    try:
        d.fetch_twstock_alerts({}, **kw)
        check(False, f"{kw} → ValueError")
    except ValueError:
        check(True, f"{kw} → ValueError")

# 10. publication timing: next day 07:30 Taipei, sparse
spec = d.FEED_TIMING["twstock_alerts"]
avail = d.feed_available_at(df, "twstock_alerts")
check(avail[0] == pd.Timestamp("2014-12-23 07:30", tz="Asia/Taipei"), f"announcement 12-22 available 12-23 07:30 ({avail[0]})")
check(spec["fresh"] is None, "sparse feed: no freshness check")

shutil.rmtree(TMP, ignore_errors=True)
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
