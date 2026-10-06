"""fetch_twfutures_bid_ask_vol, two things. No network.

① Settlement-day window filtered on return. The server's 2026-10 rebuild only deleted rows —
   the ones between the expiring month's 13:30 close and the 15:00 night open on settlement
   days — so the cache keeps its old name (twfutures_bav) and the fetcher drops those rows
   itself: months cached before the rebuild and a fresh fetch from the rebuilt server return
   the same frame. The minute label is told per day (08:45 open without zero-volume rows =
   START, the 13:30 row goes; 08:46 open with zero-volume rows = END, the 13:30 row stays;
   anything else loses only 13:31–14:59). Settlement day = the third Wednesday, or the listed
   day it was postponed to; no other day loses a row — in particular a hole in the cache (the
   third Wednesday missing, a whole month missing) never turns the next day into one.

② Cold fetch: one request per month through _retry_get, two tries each, each month written
   as it arrives, so a call that dies part-way resumes with the months it lacks. Nothing is
   asked before the first day the server has (2018-02-22).

Run: cd blave-agent && .venv/bin/python tests/check_twfutures_bav_settlement.py
"""
import os
import socket
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import pandas as pd  # noqa: E402
import requests  # noqa: E402
from lib import data as d  # noqa: E402

TPE = "Asia/Taipei"
d.time.sleep = lambda s: None            # _retry_get's backoff
HDRS = {"api-key": "k", "secret-key": "s"}


def _minutes(day, first, last):
    return pd.date_range(f"{day} {first}", f"{day} {last}", freq="1min", tz=TPE)


def _day(day, label, fillers=False):
    """One day as the store held it before the rebuild. START = tick aggregates (08:45 open, no
    zero row); END = the Touchance import (08:46 open, a zero session-reset row); MIXED =
    Touchance merged over tick rows (08:45 open). `fillers`: the settlement-day rows after the
    close are the import's zero fillers instead of the next month's volume."""
    first, last = {"start": ("08:45", "13:44"), "end": ("08:46", "13:45"), "mixed": ("08:45", "13:45")}[label]
    idx = _minutes(day, first, last).append(_minutes(day, "15:00", "15:10"))
    vol = pd.Series(3, index=idx)
    if label == "end":
        vol.iloc[0] = 0
    if fillers:
        vol[(idx >= pd.Timestamp(f"{day} 13:31", tz=TPE)) & (idx <= pd.Timestamp(f"{day} 13:45", tz=TPE))] = 0
    return pd.DataFrame({"bid_vol": vol // 3, "ask_vol": vol - vol // 3, "total_vol": vol})


def _store(first, last, label, special=None, closed=()):
    special = special or {}
    days = [str(x.date()) for x in pd.date_range(first, last, freq="D") if x.weekday() < 5]
    frames = [_day(x, *special.get(x, (label, False))) for x in days if x not in closed]
    df = pd.concat(frames)
    df.index = df.index.tz_convert("UTC")
    df.index.name = "time"
    return df


def _between(df, day, first, last):
    local = df.index.tz_convert(TPE)
    return (local >= pd.Timestamp(f"{day} {first}", tz=TPE)) & (local <= pd.Timestamp(f"{day} {last}", tz=TPE))


def _hm(result, day):
    local = result.index.tz_localize("UTC").tz_convert(TPE)
    return set(local[local.strftime("%Y-%m-%d") == day].strftime("%H:%M"))


def _write_cache(df):
    """Months already on disk, as an older lib cached them (naive UTC index, one file a month)."""
    d._CACHE_DIR = Path(tempfile.mkdtemp())
    folder = d._CACHE_DIR / "twfutures_bav_TXF"
    folder.mkdir()
    naive = df.tz_localize(None)
    for ym, grp in naive.groupby(naive.index.strftime("%Y-%m")):
        grp.to_parquet(folder / f"{ym}.parquet")
    return folder


calls, starts, failing, flaky = [], [], set(), set()
served = [None]


class _Resp:
    status_code, text = 200, ""

    def __init__(self, rows):
        self._rows = rows

    def json(self):
        return {"data": self._rows}

    def raise_for_status(self):
        pass


def _get(url, **kw):
    """The endpoint: rows of `served` in [start, end + 1 day]."""
    assert url.endswith("/studio/market/twfutures/bid_ask_vol/TXF") and kw["headers"] == HDRS, (url, kw)
    start, end = kw["params"]["start"], kw["params"]["end"]
    assert (pd.Timestamp(end) - pd.Timestamp(start)).days <= 31, (start, end)       # the endpoint's cap
    calls.append(start[:7])
    starts.append(start)
    if start[:7] in failing or (start[:7] in flaky and calls.count(start[:7]) == 1):
        raise requests.exceptions.ReadTimeout("read timeout=60")
    df = served[0]
    part = df[(df.index >= pd.Timestamp(start, tz="UTC")) & (df.index <= pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1))]
    return _Resp([{"ts": ts.isoformat(), **row} for ts, row in zip(part.index, part.to_dict("records"))])


d.requests.get = _get


def _fetch(start, end):
    return d.fetch_twfutures_bid_ask_vol(start, end, HDRS)


# ═══ ① the settlement window, read off months cached before the rebuild ═════════════════════
# 2024-01-17 END day · 2024-02-21 MIXED day · 2026-02-23 postponed (02-18 inside the Lunar New
# Year closure) · 2026-06-17 START day.
closure = {f"2026-02-{n}" for n in range(12, 21)}
old = pd.concat([
    _store("2024-01-01", "2024-02-29", "end", {"2024-01-17": ("end", True), "2024-02-21": ("mixed", True)}),
    _store("2026-02-01", "2026-02-28", "end", {"2026-02-23": ("end", True)}, closed=closure),
    _store("2026-06-01", "2026-06-30", "start"),
])
gone = (_between(old, "2024-01-17", "13:31", "14:59") | _between(old, "2024-02-21", "13:31", "14:59")
        | _between(old, "2026-02-23", "13:31", "14:59") | _between(old, "2026-06-17", "13:30", "14:59"))
assert gone.sum() == 15 * 4, gone.sum()
want = old[~gone].tz_localize(None)

_write_cache(old)
got = pd.concat([_fetch("2024-01-01", "2024-02-29"), _fetch("2026-02-01", "2026-02-28"), _fetch("2026-06-01", "2026-06-30")])
assert calls == [], calls                                             # warm cache: nothing asked
assert got.index.equals(want.index) and (got.to_numpy() == want.to_numpy()).all(), (len(got), len(want))

window = {f"{h}:{m:02d}" for h in (13, 14) for m in range(60) if (h, m) >= (13, 31)}
for day in ("2024-01-17", "2024-02-21", "2026-02-23", "2026-06-17"):
    assert not _hm(got, day) & window, (day, sorted(_hm(got, day) & window))
assert "13:30" in _hm(got, "2024-01-17")              # END: 13:29–13:30, the expiring month's last minute
assert "13:30" in _hm(got, "2024-02-21")              # label not told: only what is past the close either way
assert "13:30" in _hm(got, "2026-02-23")
assert "13:30" not in _hm(got, "2026-06-17") and "13:29" in _hm(got, "2026-06-17")   # START: 13:30:00 on
for day in ("2024-01-17", "2024-02-21", "2026-02-23", "2026-06-17"):
    assert "15:00" in _hm(got, day), day              # the night open is the next month — kept
for day in ("2024-01-16", "2024-01-18", "2026-02-11", "2026-02-24", "2026-06-16", "2026-06-18"):
    assert len(_hm(got, day)) == 300 + 11, (day, len(_hm(got, day)))

# a range that begins after the third Wednesday: its first day is an ordinary day
part = _fetch("2024-01-18", "2024-01-31")
assert part.index.min() == pd.Timestamp("2024-01-18 00:46") and len(_hm(part, "2024-01-18")) == 311
# a range that begins inside the closure before a postponed settlement still sees it as one
assert not _hm(_fetch("2026-02-20", "2026-02-28"), "2026-02-23") & window
# …also when the cached history itself begins there (nothing before it to read a closure from)
_write_cache(old[old.index >= pd.Timestamp("2024-01-18", tz=TPE)])
assert len(_hm(_fetch("2024-01-01", "2024-01-31"), "2024-01-18")) == 311

# every postponed settlement on the list: the closed third Wednesday's month loses exactly the
# listed day's window, the days around it nothing (three are older than what the fetcher
# serves or than this test's cache, so the filter is called directly)
assert sorted(d._TXF_POSTPONED_SETTLEMENT.items()) == [
    ("2013-08-21", "2013-08-22"), ("2015-02-18", "2015-02-24"), ("2023-01-18", "2023-01-30"), ("2026-02-18", "2026-02-23")]
for wed, settled in d._TXF_POSTPONED_SETTLEMENT.items():
    last = str((pd.Timestamp(wed) + pd.offsets.MonthEnd(0)).date())
    month = _store(wed[:8] + "01", last, "end", {settled: ("end", True)}, closed={wed}).tz_localize(None)
    kept = d._drop_txf_settlement_window(month)
    lost = month.index.difference(kept.index).tz_localize("UTC").tz_convert(TPE)
    assert set(lost.strftime("%Y-%m-%d")) == {settled} and len(lost) == 15, (wed, sorted(set(lost.strftime("%Y-%m-%d"))))
    assert lost.min().strftime("%H:%M") == "13:31" and "13:30" in _hm(kept, settled)

# ═══ holes in the cache are not closed markets ══════════════════════════════════════════════
# The third Wednesday's rows are missing (the server skipped that day; a past month is never
# fetched again): the month loses nothing, and the day after is an ordinary day.
no_wed = _store("2024-03-01", "2024-03-31", "start", closed={"2024-03-20"})
_write_cache(no_wed)
got_hole = _fetch("2024-03-01", "2024-03-31")
assert calls == [] and len(got_hole) == len(no_wed), (calls, len(got_hole), len(no_wed))
assert len(_hm(got_hole, "2024-03-21")) == 300 + 11
# A whole month is missing (cached as an empty month): the first day after it — nine days
# past that month's third Wednesday — is an ordinary day; the real settlement days still go.
around = pd.concat([_store("2024-01-01", "2024-01-31", "start"), _store("2024-03-01", "2024-03-31", "start")])
folder = _write_cache(around)
pd.DataFrame().to_parquet(folder / "2024-02.parquet")
got_hole = _fetch("2024-01-01", "2024-03-31")
lost = around.tz_localize(None).index.difference(got_hole.index).tz_localize("UTC").tz_convert(TPE)
assert calls == [] and sorted(set(lost.strftime("%Y-%m-%d"))) == ["2024-01-17", "2024-03-20"], (calls, lost)
assert len(lost) == 15 * 2 and len(_hm(got_hole, "2024-03-01")) == 300 + 11

# ═══ the same frame from the rebuilt server, fetched cold ═══════════════════════════════════
# The rebuild deleted START days from 13:30 and END days from 13:31, and left the day whose
# label it could not tell (2024-02-21) as it was.
rebuilt = old[~(gone & ~_between(old, "2024-02-21", "13:31", "14:59"))]
assert len(old) - len(rebuilt) == 15 * 3
served[0] = rebuilt
d._CACHE_DIR = Path(tempfile.mkdtemp())
fresh = pd.concat([_fetch("2024-01-01", "2024-02-29"), _fetch("2026-02-01", "2026-02-28"), _fetch("2026-06-01", "2026-06-30")])
assert calls == ["2024-01", "2024-02", "2026-02", "2026-06"], calls   # ② one request per month, in order
assert fresh.index.equals(got.index) and (fresh.to_numpy() == got.to_numpy()).all()

# ═══ ② a cold fetch that dies part-way keeps what it has ════════════════════════════════════
served[0] = _store("2024-01-01", "2024-06-30", "end")
d._CACHE_DIR = Path(tempfile.mkdtemp())
folder = d._CACHE_DIR / "twfutures_bav_TXF"
calls.clear()
failing.add("2024-04")
try:
    _fetch("2024-01-01", "2024-06-30")
    raise AssertionError("a month that never answers must raise")
except requests.exceptions.ReadTimeout:
    pass
assert calls == ["2024-01", "2024-02", "2024-03"] + ["2024-04"] * 2, calls       # two tries, ≈2 min at worst
assert sorted(p.stem for p in folder.glob("*.parquet")) == ["2024-01", "2024-02", "2024-03"]

failing.clear()
flaky.add("2024-05")                                                  # one timeout, then answers
calls.clear()
whole = _fetch("2024-01-01", "2024-06-30")
assert calls == ["2024-04", "2024-05", "2024-05", "2024-06"], calls   # only the missing months
assert len(list(folder.glob("*.parquet"))) == 6
assert whole.index.min() == pd.Timestamp("2024-01-01 00:46") and whole.index.max() == pd.Timestamp("2024-06-28 07:10")
calls.clear()
assert _fetch("2024-01-01", "2024-06-30").equals(whole) and calls == []

# ═══ nothing is asked before the first day the server has ═══════════════════════════════════
served[0] = _store("2018-02-22", "2018-03-30", "end")
d._CACHE_DIR = Path(tempfile.mkdtemp())
starts.clear()
early = _fetch("2017-11-01", "2018-03-31")
assert starts == ["2018-02-22", "2018-03-01"], starts
assert sorted(p.stem for p in (d._CACHE_DIR / "twfutures_bav_TXF").glob("*.parquet")) == ["2018-02", "2018-03"]
assert early.index.min() == pd.Timestamp("2018-02-22 00:46")
starts.clear()
assert _fetch("2015-01-01", "2017-12-31").empty and starts == []

print("ok")
