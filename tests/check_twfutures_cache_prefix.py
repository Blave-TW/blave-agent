"""fetch_twfutures_ohlcv cache namespace: stock futures (and their R1 spelling) use
twfutures2_* so the pre-rebuild past months are dropped; TXF and its MXF/TMF aliases keep
twfutures_*. The batch form goes through the same path. No network.

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

seen = []


def _fake_extend(prefix, params, fetch_raw_fn, start, end, **kw):
    seen.append((prefix, params["symbol"]))
    idx = pd.DatetimeIndex(["2024-01-02 01:00"])
    return pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": 1.0, "Volume": 1.0}, index=idx)


d._extend_cache_monthly = _fake_extend

cases = {
    "CDF": ("twfutures2", "CDF"), "CDFR1": ("twfutures2", "CDF"), "ccf": ("twfutures2", "CCF"),
    "TXF": ("twfutures", "TXF"), "TXFR1": ("twfutures", "TXF"), "MXF": ("twfutures", "TXF"),
    "TMF": ("twfutures", "TXF"), "MXFR1": ("twfutures", "TXF"),
}
for schema in ("1m", "1d"):
    for sym, (pre, canon) in cases.items():
        seen.clear()
        d.fetch_twfutures_ohlcv(sym, schema, "2024-01-01", "2024-01-31", {})
        assert seen == [(f"{pre}_{schema}", canon)], (sym, schema, seen)

seen.clear()
d.fetch_twfutures_ohlcv_batch(["TXF", "CDF", "TMF"], "5m", "2024-01-01", "2024-01-31", {})
assert sorted(seen) == [("twfutures2_5m", "CDF"), ("twfutures_5m", "TXF"), ("twfutures_5m", "TXF")], seen

print("ok")
