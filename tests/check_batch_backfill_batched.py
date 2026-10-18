"""Minimal check: a batch whose start is earlier than the ids' cache (an edited START while iterating
on a backtest) fills the earlier span through the /batch endpoint, chunk_size ids per request —
never one single-id request per id (lib.data _fetch_batch_cached › _make_fetch_fn; 2026-10-18 a
300-id 台股 Type C sat ≥ 60 s in 429 backoff that way). The cached later rows survive the refetch.

Run: cd blave-agent && .venv/bin/python tests/check_batch_backfill_batched.py
"""
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pandas as pd

import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


class Resp:
    def __init__(self, body):
        self.body, self.status_code = body, 200

    def json(self):
        return self.body


days = pd.bdate_range("2014-01-02", "2016-12-30")
batch_calls, single_calls = [], []


def fake_get(url, headers=None, params=None, timeout=None, **kw):
    path = urlparse(url).path
    assert "/batch/" in path, path
    ids = params["stock_ids"].split(",")
    batch_calls.append((len(ids), params["start"]))
    lo, hi = pd.Timestamp(params["start"]), pd.Timestamp(params["end"])
    rows = [{"date": str(d.date()), "open": 10.0, "close": 11.0} for d in days if lo <= d <= hi]
    return Resp({"data": {i: rows for i in ids}, "failed": []})


def raw_fn(sid, s, e, headers):
    single_calls.append(sid)
    raise AssertionError("single-id fetch")


def parse(records):
    df = pd.DataFrame(records)
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date").sort_index()[["open", "close"]].rename(
        columns={"open": "Open", "close": "Close"}).astype(float)


def main():
    D._CACHE_DIR = Path(tempfile.mkdtemp())
    D._retry_get = fake_get
    os.environ.pop("BLAVE_FETCH_FRESH_SINCE", None)
    ids = [f"9{n:03d}" for n in range(120)]
    D._fetch_batch_cached("twstock_price3", f"{D.BASE}/studio/market/twstock/batch/price_adj", "stock_ids",
                          raw_fn, parse, ids, "2016-01-04", "2016-12-30", {})
    warm = len(batch_calls)
    got = D._fetch_batch_cached("twstock_price3", f"{D.BASE}/studio/market/twstock/batch/price_adj", "stock_ids",
                                raw_fn, parse, ids, "2014-01-02", "2016-12-30", {})
    later = batch_calls[warm:]
    check(single_calls == [], f"earlier start for {len(ids)} cached ids: no single-id request ({len(single_calls)})")
    check(0 < len(later) <= 6 and all(n <= 50 for n, _ in later),
          f"filled through /batch, ≤ 50 ids per request ({len(later)} requests)")
    check(set(got) == set(ids) and all(len(got[i]) == len(days) and got[i].index[0] == days[0] for i in ids),
          "every id comes back 2014-01-02 → 2016-12-30, the cached 2016 rows included")
    print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
