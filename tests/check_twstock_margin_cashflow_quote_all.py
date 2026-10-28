"""Minimal check: the four Taiwan-stock fetchers added for the agent — per-stock margin
trading, cash-flow statement, branch search and the whole-market quote snapshot. No network:
lib.data._retry_get is stubbed and the cache dir is a temp dir.

  - fetch_twstock_margin: hits /twstock/margin/<sid>, every api column comes back as int lots
    on a naive date index, the constant stock_id is dropped, a duplicated date keeps one row,
    a range with no rows is an empty frame, one cache file per stock, a missing api column raises;
    join_tw_flow kind 'stock_margin' needs an id and attaches it with the sm_ prefix by its
    21:05 publication time, while kind 'margin' is still the whole-market fetcher
  - fetch_twstock_cashflow: hits /twstock/cashflow/<sid>, long format indexed by date, cached
    under twstock_cf, which a quarterly filing deadline invalidates like twstock_fin
  - fetch_twstock_broker_search: sends the stripped name as is (the api matches a plain
    substring), returns the api's list, refuses an empty name without a request
  - fetch_twstock_quote_all: hits /twstock/quote/all, DataFrame indexed by stock_id, rows
    without stock_id raise

Run: cd blave-agent && .venv/bin/python tests/check_twstock_margin_cashflow_quote_all.py
"""
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MPLBACKEND", "Agg")
import pandas as pd

from lib import data as d

TMP = Path(tempfile.mkdtemp(prefix="twdata-"))
d._CACHE_DIR = TMP

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


class _R:
    def __init__(self, body):
        self._b = body

    def json(self):
        return self._b


calls = []


def stub(body):
    def _get(url, **kw):
        calls.append((url, kw.get("params")))
        return _R(body)
    d._retry_get = _get


# ── margin ───────────────────────────────────────────────────────────────────────
def mrow(day, bal, limit):
    row = {c: 1 for c in d._TWSTOCK_MARGIN_COLUMNS}
    row.update(date=day, stock_id="2330", margin_balance=bal, margin_limit=limit, short_balance=7)
    return row


DAYS = ["2026-09-14", "2026-09-15", "2026-09-16"]
stub({"stock_id": "2330", "data": [mrow(DAYS[0], 29000, 6480000), mrow(DAYS[1], 29282, 6483092),
                                   mrow(DAYS[1], 29282, 6483092), mrow(DAYS[2], 29500, 6490000)]})
m = d.fetch_twstock_margin("2330", "2026-09-01", "2026-09-30", {})
check(calls and calls[-1][0].endswith("/studio/market/twstock/margin/2330")
      and calls[-1][1]["start"] <= "2026-09-01",
      f"margin: one request to /twstock/margin/2330 ({calls[-1] if calls else None})")
check(list(m.columns) == d._TWSTOCK_MARGIN_COLUMNS and "stock_id" not in m.columns,
      f"margin: the 13 api columns, stock_id dropped ({list(m.columns)})")
check(all(str(t) == "int64" for t in m.dtypes), f"margin: int lots ({set(map(str, m.dtypes))})")
check(m.index.tz is None and [x.strftime("%Y-%m-%d") for x in m.index] == DAYS,
      f"margin: naive date index, one row per day ({list(m.index)})")
check(m.loc["2026-09-15", "margin_balance"] == 29282 and m.loc["2026-09-15", "margin_limit"] == 6483092,
      "margin: values read from their own row")
check((TMP / "twstock_margin_2330.parquet").is_file() and not (TMP / "twstock_margin_2330").exists(),
      "margin: one cache file per stock (twstock_margin is in _SINGLE_FILE_PREFIXES), not month files")
short = mrow(DAYS[0], 1, 1)
del short["margin_limit"]
stub({"stock_id": "2317", "data": [short]})
try:
    d.fetch_twstock_margin("2317", "2026-09-01", "2026-09-30", {})
    check(False, "margin: an api answer missing a column raises, never pads it with 0")
except ValueError as e:
    check("margin_limit" in str(e) and not (TMP / "twstock_margin_2317.parquet").exists(),
          "margin: an api answer missing a column raises naming it, nothing cached")

stub({"stock_id": "2330", "data": []})   # a range before the stock's first row: 200 with no rows
early = d.fetch_twstock_margin("2330", "1999-01-01", "1999-12-31", {})
check(early.empty, f"margin: a range with no rows is an empty frame, not an error ({early.shape})")
stub({"stock_id": "2330", "data": [mrow(DAYS[0], 29000, 6480000), mrow(DAYS[1], 29282, 6483092),
                                   mrow(DAYS[2], 29500, 6490000)]})
again = d.fetch_twstock_margin("2330", "1999-01-01", "2026-09-30", {})
check(isinstance(again.index, pd.DatetimeIndex) and all(str(t) == "int64" for t in again.dtypes)
      and again["margin_balance"].tolist() == [29000, 29282, 29500],
      "margin: rows cached after empty months stay int lots on a date index")

calls.clear()
STOCK = pd.DataFrame({"Open": 100.0, "Close": 101.0}, index=pd.to_datetime(DAYS))
got = d.join_tw_flow(STOCK, "stock_margin", "1d", "2026-09-01", "2026-09-30", {}, id="2330")
check("sm_margin_balance" in got.columns and got["sm_margin_balance"].tolist() == [29000, 29282, 29500],
      "join_tw_flow 'stock_margin': daily bar D carries D, columns prefixed sm_")
try:
    d.join_tw_flow(STOCK, "stock_margin", "1d", "2026-09-01", None, {})
    check(False, "join_tw_flow 'stock_margin' without id raises")
except ValueError:
    check(True, "join_tw_flow 'stock_margin' without id raises")
check(d.TW_FLOWS["margin"][0] == "fetch_twmarket_margin", "kind 'margin' is still the whole market")
due = d.feed_available_at(m.loc[["2026-09-15"]], "twstock_margin")
check(str(due[0].tz_convert("Asia/Taipei"))[:16] == "2026-09-15 21:05",
      f"twstock_margin is known from D 21:05 ({due[0]})")

# ── cashflow ─────────────────────────────────────────────────────────────────────
CF = [{"date": "2025-03-31", "stock_id": "2330", "type": "CashFlowsFromOperatingActivities",
       "value": 100.0, "origin_name": "營業活動"},
      {"date": "2025-06-30", "stock_id": "2330", "type": "CashFlowsFromOperatingActivities",
       "value": 250.0, "origin_name": "營業活動"}]
calls.clear()
stub({"stock_id": "2330", "data": CF})
cf = d.fetch_twstock_cashflow("2330", {})
check(len(calls) == 1 and calls[0][0].endswith("/studio/market/twstock/cashflow/2330"),
      f"cashflow: one request to /twstock/cashflow/2330 ({calls})")
check(isinstance(cf.index, pd.DatetimeIndex) and cf["value"].tolist() == [100.0, 250.0]
      and {"type", "value", "origin_name"} <= set(cf.columns), "cashflow: long format, date index")
check((TMP / "twstock_cf_2330.parquet").exists(), "cashflow: cached as twstock_cf_2330")
calls.clear()
d.fetch_twstock_cashflow("2330", {})
check(not calls, "cashflow: a fresh cache is served without a request")
long_ago = pd.Timestamp("2026-01-01").timestamp()
check(d._filing_due_since("twstock_cf", long_ago) == d._filing_due_since("twstock_fin", long_ago) is True,
      "cashflow: a filing deadline since the write invalidates twstock_cf like twstock_fin")
check(d.FEED_TIMING["twstock_cashflow"] is d.FEED_TIMING["twstock_financials"],
      "FEED_TIMING twstock_cashflow = twstock_financials")

# ── broker search ────────────────────────────────────────────────────────────────
calls.clear()
stub({"query": "x", "data": [{"broker_id": "9217", "broker_name": "凱基-松山"}]})
rows = d.fetch_twstock_broker_search(" 凱基(松山 ", {})
check(rows == [{"broker_id": "9217", "broker_name": "凱基-松山"}], f"broker search: the api's list ({rows})")
sent = calls[-1][1]["name"]
check(calls[-1][0].endswith("/studio/market/twstock/broker/search") and sent == "凱基(松山",
      f"broker search: the stripped name sent as is — the api matches a plain substring ({sent!r})")
calls.clear()
try:
    d.fetch_twstock_broker_search("  ", {})
    check(False, "broker search: empty name raises")
except ValueError:
    check(not calls, "broker search: empty name raises before any request")

# ── whole-market quote ───────────────────────────────────────────────────────────
calls.clear()
stub({"data": [{"stock_id": "2330", "close": 2445.0, "change_rate": -0.81},
               {"stock_id": "2317", "close": 210.0, "change_rate": 1.2}]})
q = d.fetch_twstock_quote_all({})
check(calls[-1][0].endswith("/studio/market/twstock/quote/all"), "quote all: /twstock/quote/all")
check(list(q.index) == ["2330", "2317"] and q.loc["2317", "change_rate"] == 1.2,
      "quote all: DataFrame indexed by stock_id")
stub({"data": []})
check(d.fetch_twstock_quote_all({}).empty, "quote all: an empty answer is an empty frame")
stub({"data": [{"close": 1.0}]})
try:
    d.fetch_twstock_quote_all({})
    check(False, "quote all: rows without stock_id raise a clear error")
except ValueError as e:
    check("stock_id" in str(e), "quote all: rows without stock_id raise a clear error")

shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if fails else 0)
