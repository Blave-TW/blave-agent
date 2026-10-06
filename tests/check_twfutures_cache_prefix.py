"""fetch_twfutures_ohlcv cache namespace: every series (TXF with its MXF/TMF/R1 spellings, and
the stock futures) uses twfutures3_*, so the months cached before the 2026-10 settlement-day
rebuild — twfutures_* for TXF, twfutures2_* for stock futures — are re-fetched once. The batch
form goes through the same path. The TXF bid/ask volume keeps twfutures_bav: its rebuild only
deleted rows, which the fetcher filters on return (tests/check_twfutures_bav_settlement.py), so
nobody's cached months are thrown away. No network.

Run: cd blave-agent && .venv/bin/python tests/check_twfutures_cache_prefix.py
"""
import os
import socket
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import pandas as pd  # noqa: E402
from lib import data as d  # noqa: E402

seen, kwargs = [], []


def _fake_extend(prefix, params, fetch_raw_fn, start, end, **kw):
    seen.append((prefix, params["symbol"]))
    kwargs.append(kw)
    idx = pd.DatetimeIndex(["2024-01-02 01:00"])
    return pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": 1.0, "Volume": 1.0}, index=idx)


d._extend_cache_monthly = _fake_extend

cases = {
    "CDF": "CDF", "CDFR1": "CDF", "ccf": "CCF",
    "TXF": "TXF", "TXFR1": "TXF", "MXF": "TXF", "TMF": "TXF", "MXFR1": "TXF",
}
for schema in ("1m", "1d"):
    for sym, canon in cases.items():
        seen.clear()
        d.fetch_twfutures_ohlcv(sym, schema, "2024-01-01", "2024-01-31", {})
        assert seen == [(f"twfutures3_{schema}", canon)], (sym, schema, seen)

seen.clear()
d.fetch_twfutures_ohlcv_batch(["TXF", "CDF", "TMF"], "5m", "2024-01-01", "2024-01-31", {})
assert sorted(seen) == [("twfutures3_5m", "CDF"), ("twfutures3_5m", "TXF"), ("twfutures3_5m", "TXF")], seen

seen.clear()
d.fetch_twfutures_bid_ask_vol("2024-01-01", "2024-01-31", {})
assert seen == [("twfutures_bav", "TXF")], seen
assert kwargs[-1].get("month_by_month") is True, kwargs[-1]   # each month lands as it arrives

print("ok")
