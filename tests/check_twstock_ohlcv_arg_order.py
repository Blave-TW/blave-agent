"""fetch_twstock_ohlcv takes headers as its THIRD argument — the only kline fetcher that does —
and an agent writing it like the others, (stock_id, schema, start, end, headers), used to die
with `strptime() argument 1 must be str, not dict`. Both orders are the same call. No network.

Run: cd blave-agent && .venv/bin/python tests/check_twstock_ohlcv_arg_order.py
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

HDRS = {"api-key": "k", "secret-key": "s"}
seen = []


def _fake_raw(stock_id, schema, start, end, headers, adjust=False):
    seen.append(("raw", stock_id, schema, headers, adjust))
    idx = pd.DatetimeIndex(["2025-01-02 01:00", "2025-01-02 01:05"], tz="UTC")
    return pd.DataFrame({"Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5, "Volume": 3.0}, index=idx)


def _fake_extend(prefix, params, fetch_raw_fn, start, end, **kw):
    seen.append(("cache", prefix, tuple(sorted(params.items())), start, end))
    return d._normalise_index(fetch_raw_fn("2025-01-01", "2025-02-01"))


d._fetch_twstock_minute_raw, d._extend_cache_monthly = _fake_raw, _fake_extend


def _call(*a, **k):
    seen.clear()
    return d.fetch_twstock_ohlcv(*a, **k), list(seen)


documented = _call("2330", "5m", HDRS, "2025-01-01", "2025-01-31")
for other in (
    _call("2330", "5m", "2025-01-01", "2025-01-31", HDRS),               # the other fetchers' order
    _call("2330", "5m", HDRS, start="2025-01-01", end="2025-01-31"),
    _call("2330", "5m", headers=HDRS, start="2025-01-01", end="2025-01-31"),
):
    assert other[1] == documented[1], (other[1], documented[1])
    assert other[0].equals(documented[0])
assert documented[1] == [("cache", "twstock_minute_5m", (("adj", 0), ("id", "2330")), "2025-01-01", "2025-01-31"),
                         ("raw", "2330", "5m", HDRS, False)], documented[1]

# end left open, adjust passed on — in both orders
a = _call("2330", "1m", HDRS, "2025-01-01", None, True)
b = _call("2330", "1m", "2025-01-01", None, HDRS, True)
assert a[1] == b[1] and a[1][0][3:] == ("2025-01-01", None) and a[1][1] == ("raw", "2330", "1m", HDRS, True), (a[1], b[1])

print("ok")
