"""Blave 後復權 cache keys after the api's two 2026-10 fixes (stock-only dividends, then
splits / 減資 / 面額變更 from the exchange event tables): a machine that already holds complete
past data under either old key (`twstock_price_<id>.parquet` / `twstock_price2_<id>.parquet`,
`twstock_minute_<schema>_1_<id>/` / `twstock_minute_<schema>_1_<id>_2/`) must not read it — fetch_twstock_price_adj (Blave path),
fetch_twstock_price_adj_batch and fetch_twstock_ohlcv(adjust=True) return what the api answers
now. Raw series did not change and keep their keys: the old raw minute / raw daily cache is
still served without a request. No network.

Run: cd blave-agent && .venv/bin/python tests/check_twstock_adj_cache_key.py
"""
import atexit
import os
import shutil
import socket
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ["BLAVE_TWSTOCK_DAILY_SOURCE"] = "blave"


def _no_network(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_network

import pandas as pd  # noqa: E402
from lib import data as d  # noqa: E402

TMP = tempfile.mkdtemp(prefix="tw-adj-key-")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)
OLD, NEW = 1.0, 500.0
DAYS = pd.bdate_range("2024-01-02", "2024-06-28")
MINUTES = pd.date_range("2024-01-02 01:00", "2024-01-31 05:00", freq="5min")
fails = 0
calls = []


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails += 1


def daily(px, cols=("Open", "Close")):
    return pd.DataFrame({c: px for c in cols}, index=DAYS)


def minute(px):
    return pd.DataFrame({c: px for c in ("Open", "High", "Low", "Close", "Volume")}, index=MINUTES)


# Complete past history under the old keys: the pre-change code serves it with no request.
DONE = {"from": "2024-01", "to": "2024-06", "tail_fetched_at": "2024-07-05T00:00:00"}


def seed_old_cache():
    d._CACHE_DIR = Path(tempfile.mkdtemp(dir=TMP))
    for prefix in ("twstock_price", "twstock_price2"):
        d._write_single(prefix, {"id": "2330"}, daily(OLD), DONE)
    d._write_single("twstock_price_nonadj", {"id": "2330"},
                    daily(OLD, ("Open", "High", "Low", "Close", "Volume")), DONE)
    for params in ({"adj": 0}, {"adj": 1}, {"adj": 1, "v": 2}):
        mdir = d._monthly_cache_dir("twstock_minute_5m", {"id": "2330", **params})
        mdir.mkdir(parents=True)
        minute(OLD).to_parquet(mdir / "2024-01.parquet")


class _Resp:
    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def _fake_get(url, headers=None, params=None, timeout=None, **kw):
    calls.append(url)
    days = [{"date": t.strftime("%Y-%m-%d"), "open": NEW, "high": NEW, "low": NEW, "close": NEW,
             "volume": NEW} for t in DAYS]
    if "/batch/" in url:
        return _Resp({"data": {"2330": days}, "failed": []})
    if "/minute/ohlcv/" in url:
        return _Resp({"data": [{"ts": t.isoformat() + "Z", "open": NEW, "high": NEW, "low": NEW,
                                "close": NEW, "volume": NEW} for t in MINUTES]})
    return _Resp({"data": days})


d._retry_get = _fake_get

seed_old_cache()
df = d.fetch_twstock_price_adj("2330", "2024-01-02", "2024-06-28", {})
check(len(df) and (df["Close"] == NEW).all(), "single adj: old twstock_price_2330 / twstock_price2_2330 not read")

seed_old_cache()
got = d.fetch_twstock_price_adj_batch(["2330"], "2024-01-02", "2024-06-28", {}).get("2330")
check(got is not None and len(got) and (got["Close"] == NEW).all(),
      "batch adj: old twstock_price_2330 / twstock_price2_2330 not read")

seed_old_cache()
df = d.fetch_twstock_ohlcv("2330", "5m", {}, "2024-01-02", "2024-01-31", adjust=True)
check(len(df) and (df["Close"] == NEW).all(), "minute adj: old twstock_minute_5m_1_2330(_2) not read")

calls.clear()
df = d.fetch_twstock_ohlcv("2330", "5m", {}, "2024-01-02", "2024-01-31", adjust=False)
check(len(df) and (df["Close"] == OLD).all() and not calls,
      "minute raw: twstock_minute_5m_0_2330 still served, no request")

calls.clear()
df = d.fetch_twstock_price("2330", "2024-01-02", "2024-06-28", {})
check(len(df) and (df["Close"] == OLD).all() and not calls,
      "daily raw: twstock_price_nonadj_2330 still served, no request")

print("FAILED" if fails else "ok")
sys.exit(1 if fails else 0)
