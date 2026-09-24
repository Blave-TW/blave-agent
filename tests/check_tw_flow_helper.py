"""Minimal check: lib.data.join_tw_flow (fetch a Taiwan daily flow feed + attach it by
publication time in one call), the resolved FEED_TIMING times, and the fundamental cache
refreshing after a filing deadline. No network: fetchers are stubbed.

  - join_tw_flow on TXF 60m bars (naive UTC) = align_feed with bar_tz='UTC', columns
    prefixed; on daily stock bars (naive Taipei dates) bar D carries D; a Series feed
    (broker_total) becomes one column; live with today's row missing → FeedNotPublished
  - a strategy written with join_tw_flow passes the runner's look-ahead check (feed replayed
    by publication time), and the same flow joined by date onto intraday bars is refused
  - FEED_TIMING: 金融保險業 Q2 → 9/1, 保險業 revenue → the 15th from 2026, api day-cache
    feeds → next day 08:00, 5-minute api cache on the TW daily endpoints, bid/ask 30 s
  - the 30-day fundamental cache is ignored once a filing became servable after it was written

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_flow_helper.py
"""
import contextlib
import io
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.data as D
import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


TPE = "Asia/Taipei"
rng = np.random.default_rng(5)
DAYS = pd.bdate_range("2025-01-01", "2025-12-31")
HOURS = (9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23)
BIG = pd.DatetimeIndex([d + pd.Timedelta(hours=h) for d in DAYS.tz_localize(TPE) for h in HOURS])
px = 20000 * np.exp(np.cumsum(rng.normal(0, 0.003, len(BIG))))
TXF = pd.DataFrame({"Open": px, "High": px, "Low": px, "Close": px, "Volume": 1.0},
                   index=BIG.tz_convert("UTC").tz_localize(None))
FUT = pd.DataFrame({"foreign_net_oi": rng.normal(0, 1, len(DAYS)), "dealer_net_oi": rng.normal(0, 1, len(DAYS))},
                   index=DAYS)
STOCK = pd.DataFrame({"Open": 100.0, "Close": 100 + rng.normal(0, 1, len(DAYS)).cumsum()}, index=DAYS)
INST = pd.DataFrame({"foreign_net": rng.normal(0, 1e3, len(DAYS))}, index=DAYS)
BROKER = pd.Series(rng.normal(0, 1e3, len(DAYS)), index=DAYS, name="net")

D.fetch_twfutures_ohlcv = lambda symbol, schema, start, end, headers: TXF.copy()
D.fetch_twfutures_institutional = lambda futures_id, start, end, headers: FUT.copy()
D.fetch_twstock_institutional = lambda stock_id, start, end, headers: INST.copy()
D.fetch_twstock_all_broker_net = lambda stock_id, start, end, headers, **k: BROKER.copy()

# ── the helper ───────────────────────────────────────────────────────────────────
got = D.join_tw_flow(TXF, "futures_institutional", "60m", "2025-01-01", None, {}, id="TX")
ref = D.align_feed(TXF, FUT, "twfutures_institutional", "60m", bar_tz="UTC")
check(list(got.columns[-2:]) == ["fut_foreign_net_oi", "fut_dealer_net_oi"]
      and got["fut_foreign_net_oi"].equals(ref["foreign_net_oi"]) and got.index.equals(ref.index),
      "futures_institutional on 60m bars (naive UTC) = align_feed(bar_tz='UTC'), columns prefixed fut_")
tpe = got.index.tz_localize("UTC").tz_convert(TPE)
day_bar = got[(tpe.hour == 12)].iloc[50]
night_bar = got[(tpe.hour == 18)].iloc[50]
d_day = day_bar.name.tz_localize("UTC").tz_convert(TPE).normalize().tz_localize(None)
d_night = night_bar.name.tz_localize("UTC").tz_convert(TPE).normalize().tz_localize(None)
check(day_bar["fut_foreign_net_oi"] == FUT["foreign_net_oi"].shift(1).loc[d_day]
      and night_bar["fut_foreign_net_oi"] == FUT.loc[d_night, "foreign_net_oi"],
      "期貨法人[D] (served D 18:05): the 12:00 bar still carries D-1, the 18:00 bar (close 19:00) carries D")
daily = D.join_tw_flow(STOCK, "stock_institutional", "1d", "2025-01-01", None, {}, id="2330")
check(daily["inst_foreign_net"].equals(INST["foreign_net"]),
      "stock_institutional on daily bars (naive Taipei dates): bar D carries D")
bt = D.join_tw_flow(STOCK, "broker_total", "1d", "2025-01-01", None, {}, id="2330")
check("broker_net" in bt.columns and bt["broker_net"].equals(BROKER),
      "broker_total (a Series feed) → one column broker_net")
D.fetch_twstock_institutional = lambda stock_id, start, end, headers: INST.iloc[:-1].copy()
try:
    with D.live_feeds():
        D.join_tw_flow(STOCK, "stock_institutional", "1d", "2025-01-01", None, {}, id="2330")
    check(False, "live with today's row missing must raise")
except D.FeedNotPublished:
    check(True, "live with today's row missing → FeedNotPublished")
D.fetch_twstock_institutional = lambda stock_id, start, end, headers: INST.copy()
for bad in (dict(kind="nope"), dict(kind="stock_institutional")):
    try:
        D.join_tw_flow(STOCK, interval="1d", start="2025-01-01", end=None, headers={}, **bad)
        check(False, f"bad call {bad} must raise")
    except ValueError:
        check(True, f"bad call {bad} → ValueError")

# ── the runner: helper passes, a plain date join onto intraday bars is refused ──────
WS = Path(tempfile.mkdtemp(prefix="tw-flow-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"


def with_helper(hdrs):
    from lib.data import fetch_twfutures_ohlcv, join_tw_flow
    df = fetch_twfutures_ohlcv("TXF", "60m", "2025-01-01", None, hdrs)
    return join_tw_flow(df, "futures_institutional", "60m", "2025-01-01", None, hdrs, id="TX")


def by_date(hdrs):
    from lib.data import fetch_twfutures_ohlcv, fetch_twfutures_institutional
    df = fetch_twfutures_ohlcv("TXF", "60m", "2025-01-01", None, hdrs)
    fut = fetch_twfutures_institutional("TX", "2025-01-01", None, hdrs)
    day = df.index.tz_localize("UTC").tz_convert(TPE).normalize().tz_localize(None)
    df["fut_foreign_net_oi"] = fut["foreign_net_oi"].reindex(day).to_numpy()
    return df


def signal(df):
    return (df["fut_foreign_net_oi"] > 0).astype(float).where(df["fut_foreign_net_oi"].notna())


saved = runner.LOOKAHEAD_CUTS
runner.LOOKAHEAD_CUTS = 40
for name, fetch, want_refused in (("helper", with_helper, False), ("by_date", by_date, True)):
    out, refused = io.StringIO(), None
    with contextlib.redirect_stdout(out):
        try:
            runner.run({"STRATEGY_NAME": name, "SYMBOL": "TXF", "INTERVAL": "60m", "START": "2025-01-01",
                        "FEE": 0.0001, "MCPT": False}, fetch, signal)
        except SystemExit as e:
            refused = str(e)
    if want_refused:
        check(bool(refused) and "align_feed" in refused, "flow joined by date onto 60m bars → refused, message points to align_feed")
    else:
        check(refused is None and "Look-ahead check: passed" in out.getvalue()
              and "fetch_data + compute_signals" in out.getvalue(),
              "strategy written with join_tw_flow passes the look-ahead check" + (f" — {refused}" if refused else ""))
runner.LOOKAHEAD_CUTS = saved

# ── resolved FEED_TIMING times ─────────────────────────────────────────────────────
def at(source, stamps, **frame_cols):
    idx = pd.DatetimeIndex(stamps)
    frame = pd.DataFrame({"v": 1.0, **frame_cols}, index=idx)
    return [t.strftime("%Y-%m-%d %H:%M") for t in D.feed_available_at(frame, source).tz_convert(TPE)]


check(at("twstock_financials_finance", ["2026-06-30"]) == ["2026-09-01 08:00"]
      and at("twstock_financials", ["2026-06-30"]) == ["2026-08-15 08:00"],
      "Q2 statements: 金融保險業 8/31 deadline → 09-01 08:00; general 8/14 → 08-15 08:00")
check(at("twstock_monthly_revenue_insurance", ["2025-12-01", "2026-04-01"]) == ["2025-12-11 08:00", "2026-04-16 08:00"],
      "保險業 revenue: the 10th before FY2026, the 15th from it (+ FinMind 18:00, api day cache)")
check(at("twstock_monthly_revenue", ["2026-05-01"]) == ["2026-05-12 08:00"],
      "revenue due Sunday 05-10 → FinMind Monday 18:00 → served 05-12 08:00")
check(at("twstock_foreign_shareholding", ["2026-09-23"]) == ["2026-09-24 08:00"],
      "外資持股 (api UTC-day cache) → next day 08:00")
check(at("twmarket_institutional", ["2026-09-23"]) == ["2026-09-23 19:45"]
      and at("twmarket_margin", ["2026-09-23"]) == ["2026-09-23 21:05"],
      "TWSE final times + 5 min api cache (三大法人金額 19:45, 融資融券 21:05)")
bav = D.feed_available_at(pd.DataFrame({"v": [1.0, 2.0]}, index=pd.date_range("2026-09-23 01:00", periods=2, freq="1min")),
                          "twfutures_bid_ask_vol")
check(bav[0] == pd.Timestamp("2026-09-23 01:01:30", tz="UTC"), f"bid/ask minute row: final 30 s after the minute closes ({bav[0]})")

# ── fundamental cache refresh after a deadline ──────────────────────────────────────
path = WS / "cache_rev.parquet"
pd.DataFrame({"revenue": [1.0]}, index=pd.DatetimeIndex(["2026-01-01"])).to_parquet(path)
last_due = max(t for t in D.feed_available_at(pd.DataFrame({"v": 1.0}, index=pd.date_range(
    "2025-01-01", pd.Timestamp.now().normalize(), freq="MS")), "twstock_monthly_revenue")
               if t <= pd.Timestamp.now(tz=TPE))
before = (last_due - pd.Timedelta(hours=1)).timestamp()
os.utime(path, (before, before))
check(D._load_fundamental_cache(path, prefix="twstock_rev") is None,
      f"revenue cache written before the {last_due:%m-%d %H:%M} due time → refetched")
os.utime(path, (time.time(), time.time()))
check(D._load_fundamental_cache(path, prefix="twstock_rev") is not None, "a cache written after it → kept")
os.utime(path, (before, before))
check(D._load_fundamental_cache(path) is not None, "no prefix (dividend etc.) → old 30-day rule unchanged")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
