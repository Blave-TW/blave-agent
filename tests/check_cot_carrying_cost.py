"""Minimal check: lib.data.fetch_cme_cot and fetch_twfutures_carrying_cost. No network:
_retry_get is stubbed with rows copied from live API-key responses (2026-10-07).

  - fetch_cme_cot: nested tff / legacy groups flatten to `{report}_{group}_{field}` columns,
    one row per report date, `included` kept for a combined contract, `legacy: null` → NaN,
    attrs carry the CFTC attribution; a bad contract fails before any request
  - fetch_twfutures_carrying_cost: date index, float columns, cycle_start a Timestamp,
    attrs['stale']; 外資 maps to 'foreign'; scope passed through
  - FEED_TIMING: the COT row counts from the Friday of its week 16:30 New York — Monday report
    dates, Wed–Fri holiday weeks (→ next business day) and the 2018-19 / 2025 shutdown catch-ups
    pinned; carrying cost
    from D 17:50 Taipei — join_tw_flow on 60m TXF bars hands D's row first to the bar closing
    at/after 17:50 and never to D's day session

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_cot_carrying_cost.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import pandas as pd

import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def grp(**kw):
    return dict(kw)


COT_ROWS = [
    {"date": "2021-04-27", "included": ["btc"], "legacy": None, "open_interest": 52720.0,
     "open_interest_change": 1150.0, "price": 54859.48,
     "tff": {"leveraged_funds": grp(long=8000.0, short=30000.0, spread=500.0, net=-22000.0,
                                    long_change=10.0, short_change=-20.0, spread_change=0.0,
                                    net_change=30.0),
             "nonreportable": grp(long=4000.0, short=3000.0, net=1000.0, long_change=1.0,
                                  short_change=2.0, net_change=-1.0)}},
    {"date": "2026-09-29", "included": ["btc", "micro_btc"], "open_interest": 100612.0,
     "open_interest_change": -14522.7, "price": 83663.66,
     "tff": {"leveraged_funds": grp(long=25889.6, short=61305.6, spread=2742.4, net=-35416.0,
                                    long_change=680.4, short_change=-4283.9,
                                    spread_change=-11214.8, net_change=4964.3),
             "nonreportable": grp(long=6131.2, short=4190.6, net=1940.6, long_change=-960.7,
                                  short_change=-691.9, net_change=-268.8)},
     "legacy": {"non_commercial": grp(long=87773.3, short=76018.4, spread=6353.0, net=11754.9,
                                      long_change=-2879.6, short_change=-1457.0,
                                      spread_change=-10540.3, net_change=-1422.6)}},
]
COT_BODY = {"data": {"contract": {"key": "btc_combined", "coin": "BTC", "micro_since": "2021-05-04"},
                     "rows": COT_ROWS, "units": "coins", "source": "Source: U.S. Commodity Futures "
                     "Trading Commission (CFTC) ...", "price_source": "Binance spot BTCUSDT ...",
                     "stale": False, "source_updated": "Fri, 02 Oct 2026 19:30:08 GMT",
                     "report": "futures_only"}}

CC_ROWS = [
    {"cost": 46344.85, "cycle_start": "2026-09-16", "date": "2026-10-02", "mark_price": 48673.93,
     "net_open_interest": -80345.15, "net_open_interest_change": -1023.0,
     "realized_pnl": -2255597517, "total_pnl": -39681648696, "txf_close": 48671.0,
     "unrealized_pnl": -37426051180},
    {"cost": 46344.85, "cycle_start": "2026-09-16", "date": "2026-10-05", "mark_price": 49948.76,
     "net_open_interest": -74647.2, "net_open_interest_change": 5697.95,
     "realized_pnl": -5893982992, "total_pnl": -59698322924, "txf_close": 49949.0,
     "unrealized_pnl": -53804339932},
]


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


calls = []


def fake_retry_get(url, **kw):
    calls.append((url, dict(kw.get("params") or {})))
    if url.endswith("/cme_cot/get_history"):
        return FakeResponse(COT_BODY)
    if "/twfutures/carrying_cost/" in url:
        return FakeResponse({"data": CC_ROWS, "identity": url.rsplit("/", 1)[1],
                             "scope": kw["params"]["scope"], "stale": True})
    raise AssertionError(f"unexpected request {url}")


D._retry_get = fake_retry_get
H = {"api-key": "x", "secret-key": "y"}

print("fetch_cme_cot")
cot = D.fetch_cme_cot("BTC_Combined", "2018-01-01", None, H)
check(calls[-1] == (f"{D.BASE}/cme_cot/get_history", {"contract": "btc_combined", "start_date": "2018-01-01"}),
      "request: lower-cased contract, start_date sent, no end_date")
check(list(cot.index) == [pd.Timestamp("2021-04-27"), pd.Timestamp("2026-09-29")], "one row per report date, ascending")
check(cot.loc["2026-09-29", "tff_leveraged_funds_net"] == -35416.0, "tff group flattened")
check(cot.loc["2026-09-29", "legacy_non_commercial_spread_change"] == -10540.3, "legacy group flattened")
check(pd.isna(cot.loc["2021-04-27", "legacy_non_commercial_net"]), "legacy null → NaN")
check(cot.loc["2021-04-27", "included"] == "btc", "included kept")
check(cot["price"].dtype == float and cot.attrs["source"].startswith("Source: U.S. Commodity"), "price float, attribution in attrs")
n = len(calls)
try:
    D.fetch_cme_cot("sol", None, None, H)
    check(False, "bad contract raises")
except ValueError:
    check(len(calls) == n, "bad contract raises before any request")

print("fetch_twfutures_carrying_cost")
cc = D.fetch_twfutures_carrying_cost("外資", "2026-10-01", None, H, scope="tx")
check(calls[-1] == (f"{D.BASE}/studio/market/twfutures/carrying_cost/foreign", {"scope": "tx", "start": "2026-10-01"}),
      "外資 → foreign, scope + start sent")
check(cc.index[0] == pd.Timestamp("2026-10-02") and cc["cost"].dtype == float, "date index, float columns")
check(cc["cycle_start"].iloc[0] == pd.Timestamp("2026-09-16"), "cycle_start is a Timestamp")
check(cc.attrs["stale"] is True and cc.attrs["identity"] == "foreign", "attrs: stale, identity")

print("FEED_TIMING")
tue = pd.DatetimeIndex([pd.Timestamp("2026-09-29")])
avail = D.feed_available_at(pd.DataFrame({"x": [1.0]}, index=tue), "cme_cot")[0]
check(avail == pd.Timestamp("2026-10-02 16:30", tz="America/New_York"), f"COT Tuesday → Friday 16:30 New York ({avail})")


def cot_avail(day):
    idx = pd.DatetimeIndex([pd.Timestamp(day)])
    return D.feed_available_at(pd.DataFrame({"x": [1.0]}, index=idx), "cme_cot")[0]


NY = "America/New_York"
for day, want, why in (
    ("2023-07-03", "2023-07-07 16:30", "Monday report date (July 4 on Tuesday) → that Friday, not Thursday"),
    ("2020-12-21", "2020-12-28 16:30", "Monday report date, Dec 24–25 closed → next Monday"),
    ("2026-11-24", "2026-11-30 16:30", "Thanksgiving week → Monday (CFTC 2026 schedule 11-30*)"),
    ("2026-06-16", "2026-06-22 16:30", "Juneteenth Friday → Monday (CFTC 2026 schedule 06-22*)"),
    ("2026-01-20", "2026-01-23 16:30", "MLK Monday before the report date → still Friday"),
    ("2025-11-10", "2025-12-12 16:30", "2025 shutdown, Monday report date → CFTC catch-up date"),
    ("2025-10-07", "2025-11-21 16:30", "2025 shutdown catch-up"),
    ("2018-12-24", "2019-02-01 16:30", "2018-19 shutdown, first catch-up"),
    ("2019-02-26", "2019-03-05 16:30", "2018-19 shutdown, last catch-up"),
    ("2019-03-05", "2019-03-08 16:30", "back to the normal Friday"),
):
    got = cot_avail(day)
    check(got == pd.Timestamp(want, tz=NY), f"COT {day}: {why} ({got})")
bars = pd.DataFrame({"Close": 1.0}, index=pd.date_range("2025-11-09", "2025-12-14", freq="D"))
cot_feed = pd.DataFrame({"v": [1.0, 2.0]}, index=pd.DatetimeIndex(["2025-11-04", "2025-11-10"]))
al = D.align_feed(bars, cot_feed, "cme_cot", "1d", bar_tz="UTC")
check(al.loc["2025-12-11", "v"] == 1.0 and al.loc["2025-12-12", "v"] == 2.0,
      "align_feed on daily UTC bars: the 2025-11-10 report reaches the 12-12 bar (closes 12-13 00:00 UTC), not before")
avail = D.feed_available_at(cc[["cost"]], "twfutures_carrying_cost")[0]
check(avail == pd.Timestamp("2026-10-02 17:50", tz="Asia/Taipei"), f"carrying cost D → D 17:50 Taipei ({avail})")

print("join_tw_flow carrying_cost on 60m TXF bars (naive UTC)")
# 2026-10-05 Taipei: day-session bars 08:45–13:45 = 00:45–05:45 UTC; 17:00 Taipei = 09:00 UTC
idx = pd.DatetimeIndex(["2026-10-05 01:00", "2026-10-05 05:00", "2026-10-05 08:00",
                        "2026-10-05 09:00", "2026-10-05 10:00"])
bars = pd.DataFrame({"Close": [1.0] * len(idx)}, index=idx)
out = D.join_tw_flow(bars, "carrying_cost", "60m", "2026-10-01", None, H, id="foreign")
day = pd.Timestamp("2026-10-02")
check((out.loc["2026-10-05 01:00", "cc_cost"] == cc.loc[day, "cost"]), "10-05 day session sees 10-02's row")
check(out.loc["2026-10-05 08:00", "cc_net_open_interest"] == cc.loc[day, "net_open_interest"],
      "the bar closing 17:00 Taipei still sees 10-02")
check(out.loc["2026-10-05 09:00", "cc_net_open_interest"] == cc.loc[pd.Timestamp("2026-10-05"), "net_open_interest"],
      "the bar closing 18:00 Taipei (first after 17:50) sees 10-05")

print("FAILED" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
