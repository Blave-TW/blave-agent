"""An intraday TW Type A on paper fills and marks at its latest unadjusted bar, not the day
before's close (audit 0127-crossfix 1.3), and the portfolio page sizes its shares off that
same bar (lib/runner child → raw_closes). That bar unreadable → the previous daily close,
noted on the fill (paper_data.tw_price_note). Offline: every price is stubbed.

Run: cd blave-agent && .venv/bin/python tests/check_paper_tw_intraday.py
"""
import json, os, sys, tempfile, time
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
WS = tempfile.mkdtemp(prefix="papertw-intraday-")
os.chdir(WS)
for d in ("state", "strategies/tw_h", "strategies/tw_d"):
    os.makedirs(d, exist_ok=True)
open("strategies/tw_h/strategy.py", "w").write(
    'SYMBOL = "2330"\nINTERVAL = "1h"\n\ndef fetch_data(hdrs):\n    raise RuntimeError("never for a price")\n')
open("strategies/tw_d/strategy.py", "w").write(
    'SYMBOL = "2454"\nINTERVAL = "1d"\n\ndef fetch_data(hdrs):\n    raise RuntimeError("never for a price")\n')
TODAY = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
YDAY = (datetime.now(timezone(timedelta(hours=8))) - timedelta(days=1)).strftime("%Y-%m-%d")
open("twfake.py", "w").write(f'''
import os
import pandas as pd


def batch(codes, start, end, hdrs):
    return {{c: pd.DataFrame({{"Close": [2420.0]}}, index=pd.to_datetime(["{YDAY}"])) for c in codes}}


def intraday(code, schema, hdrs):
    if os.path.exists("state/bar_down"):
        raise OSError("no minute bars")
    open("state/intraday_asked", "w").write(schema)
    return ["{TODAY}", 2450.0]
''')

import pandas as pd  # noqa: E402
from lib import data, order_paper, paper_data, runner  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def offline(*a, **k):
    raise OSError("no network in this test")


print("== schema of an INTERVAL")
cases = {"1h": "60m", "4h": "60m", "15m": "15m", "5min": "5m", "45m": "15m", "1m": "1m", "1d": None, "1w": None, "": None}
got = {k: paper_data.tw_intraday_schema(k) for k in cases}
check(got == cases, f"{got}")

ohlcv = []
BAR = [2450.0]


def fake_ohlcv(code, schema, hdrs, start=None, end=None, adjust=False):
    ohlcv.append((code, schema, adjust))
    if os.path.exists("state/bar_down"):
        raise OSError("no minute bars")
    idx = pd.DatetimeIndex([pd.Timestamp.now(tz="UTC").floor("h") - pd.Timedelta(hours=1),
                            pd.Timestamp.now(tz="UTC").floor("h")])
    return pd.DataFrame({"Open": BAR[0], "High": BAR[0], "Low": BAR[0], "Close": [BAR[0] - 10, BAR[0]],
                         "Volume": 1.0}, index=idx)


daily = []


def fake_daily(code, start, end, hdrs):
    daily.append(code)
    px = {"2330": 2420.0, "2454": 1255.0}[code]
    return pd.DataFrame({"Open": px, "Close": px}, index=[pd.Timestamp(YDAY)])


paper_data._fetch_fx = offline
data.fetch_twstock_ohlcv = fake_ohlcv
data.fetch_twstock_price = fake_daily
order_paper.tw_session_open = lambda env=None, now=None: True
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))
ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1",
       "PAPER_INITIAL_EQUITY": "200000"}

print("== paper: an intraday Type A's symbol at its latest unadjusted bar")
px, _ = paper_data.current_price("2330", ENV)
check(px == 2450.0 and ohlcv == [("2330", "60m", False)] and "2330" not in daily,
      f"1h strategy → the latest raw 60m bar, not the day before's close ({px}, {ohlcv}, {daily})")
check(paper_data.tw_price_note("2330") is None, "no note")
r = order_paper.place_spot_market_order(ENV, "2330", "buy", quote_qty=245000.0)
check(r and r["avg_price"] == 2450.0 and r["executed_qty"] == 100.0, f"fills 100 shares at 2450 ({r and r['avg_price']})")
ohlcv.clear()
paper_data._price_cache.clear()
px, _ = paper_data.current_price("2454", ENV)
check(px == 1255.0 and not ohlcv, f"a daily Type A's symbol: the daily close, no minute fetch ({px})")

print("== the bar unreadable: the previous daily close, noted on the fill")
open("state/bar_down", "w").write("1")
paper_data._price_cache.clear()
px, _ = paper_data.current_price("2330", ENV)
check(px == 2420.0 and "previous daily close" in (paper_data.tw_price_note("2330") or ""),
      f"falls back to 2420 with a note ({px}, {paper_data.tw_price_note('2330')})")
r = order_paper.place_spot_market_order(ENV, "2330", "buy", quote_qty=24200.0)
fill = json.load(open(order_paper.LEDGER_PATH))["fills"][-1]
check(r and r["avg_price"] == 2420.0 and "previous daily close" in fill.get("price_note", ""),
      f"the fill carries price_note ({fill.get('price_note')})")
os.remove("state/bar_down")
paper_data._price_cache.clear()
paper_data.current_price("2330", ENV)
check(paper_data.tw_price_note("2330") is None, "the note clears once the bar is back")

print("== page: the runner child sizes an intraday Type A at the same bar")
runner.TW_CLOSE_FETCH = "twfake:batch"
runner.TW_INTRADAY_FETCH = "twfake:intraday"
need = {"2330": (TODAY, False)}
out = runner.tw_fetch_closes({}, need, {}, schema="60m")
check(out and out["raw_closes"] == {"2330": 2450.0} and out["raw_close_dates"] == {"2330": TODAY}
      and not out.get("raw_closes_est"),
      f"raw close = the latest 60m bar, today's, not an estimate ({out})")
check(open("state/intraday_asked").read() == "60m", "asked with the strategy's schema")
BAR[0] = 2450.0
paper_data._price_cache.clear()
check(paper_data.current_price("2330", ENV)[0] == out["raw_closes"]["2330"], "page price == paper fill price")
out = runner.tw_fetch_closes({}, need, {})
check(out and out["raw_closes"] == {"2330": 2420.0} and out.get("raw_closes_est") == ["2330"],
      f"a daily strategy (no schema): the daily close, an estimate until today's lands ({out})")
open("state/bar_down", "w").write("1")
out = runner.tw_fetch_closes({}, need, {}, schema="60m")
check(out and out["raw_closes"] == {"2330": 2420.0} and out.get("raw_closes_est") == ["2330"],
      f"the bar unreadable in the child: the daily close, an estimate ({out})")
os.remove("state/bar_down")
check(runner._tw_schema("1h") == "60m" and runner._tw_schema("1d") is None, "runner maps INTERVAL the same way")
src = open(os.path.join(ROOT, "lib", "runner.py"), encoding="utf-8").read()
check("schema=_tw_schema(interval)" in src, "the Type A live tick passes its INTERVAL")

print("ALL OK" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
