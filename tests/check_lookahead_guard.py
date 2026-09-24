"""Minimal check: every backtest runs the truncation-invariance (look-ahead) check and refuses
a strategy whose past positions change when later bars are removed.

Drives the real lib/runner.run() in backtest mode in a temp workspace — no network: the
lib.data fetchers a strategy calls are replaced with synthetic ones.

  refused (「偷看未來」, no stats.json): shift(-1), bfill, full-sample z-score, full-sample
    percentile, resample(label='left') — in compute_signals, plus a full-sample z-score
    built in fetch_data (_add_indicators path, caught through the lib.data replay) and a
    Type C portfolio on the old `(s != s.shift(-1)).fillna(True)` rebalance mask
    and the same shift(-1) after fetch_data moved the index from naive UTC to Asia/Taipei
  passes: SMA cross with warm-up NaNs (also after that zone change), a correct label='right'
    higher timeframe, an external daily feed aligned with its publication lag, a naive
    Taipei-wall-clock feed under Taipei-aware bars, TAIFEX
    settlement-masked bars, CME settlement_signals_from_db bars, Type C on the
    first-bar-of-period mask
  never refused: a nondeterministic strategy (the check cannot reproduce itself → skipped)

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_lookahead_guard.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
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


WS = Path(tempfile.mkdtemp(prefix="lookahead-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(3)
N = 1500
IDX = pd.date_range("2025-01-01", periods=N, freq="1h")
close = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, N)))
BARS = pd.DataFrame({"Open": close * (1 + rng.normal(0, 0.001, N)), "High": close * 1.01,
                     "Low": close * 0.99, "Close": close, "Volume": 1.0}, index=IDX)
# daily feed, stamped at the day it describes; published one day later
FEED = pd.Series(rng.normal(0, 1, N // 24 + 2),
                 index=pd.date_range("2025-01-01", periods=N // 24 + 2, freq="1D"), name="feed")

D.fetch_kline = lambda symbol, interval, start, end, headers, max_retries=6: BARS.copy()
D.fetch_funding_rate = lambda symbol, interval, start, end, headers, exchange='binance': \
    FEED.to_frame("alpha")


def backtest(name, fetch, compute, **cfg):
    """→ (refusal message or None, stdout, stats.json exists)"""
    config = {"STRATEGY_NAME": name, "SYMBOL": "SYN", "INTERVAL": "1h",
              "START": "2025-01-01", "FEE": 0.0005, "MCPT": False, **cfg}
    out, refused = io.StringIO(), None
    with contextlib.redirect_stdout(out):
        try:
            runner.run(config, fetch, compute, send_telegram_fn=None)
        except SystemExit as e:
            refused = str(e)
    return refused, out.getvalue(), (WS / "strategies" / name / "stats.json").exists()


def fetch_plain(hdrs):
    from lib.data import fetch_kline
    return fetch_kline("SYN", "1h", "2025-01-01", None, hdrs)


def expect_refused(name, fetch, compute, **cfg):
    refused, _, has_stats = backtest(name, fetch, compute, **cfg)
    check(bool(refused) and "偷看未來" in refused and not has_stats,
          f"{name}: refused as 偷看未來, no stats.json")


def expect_pass(name, fetch, compute, **cfg):
    refused, out, has_stats = backtest(name, fetch, compute, **cfg)
    check(refused is None and has_stats and "Look-ahead check: passed" in out,
          f"{name}: passes, stats.json written" + (f" — got {refused!r}" if refused else ""))


# ── leaks in compute_signals ────────────────────────────────────────────────────
expect_refused("leak_shift", fetch_plain,
               lambda df: (df["Close"].shift(-1) > df["Close"]).astype(float))


def bfill_fetch(hdrs):
    df = fetch_plain(hdrs)
    df["feed"] = FEED.reindex(df.index)          # values only on the 00:00 bar, NaN between
    return df


expect_refused("leak_bfill", bfill_fetch,
               lambda df: (df["feed"].bfill() > 0).astype(float))
expect_refused("leak_zscore", fetch_plain,
               lambda df: ((df["Close"] - df["Close"].mean()) / df["Close"].std() > 0).astype(float))
expect_refused("leak_percentile", fetch_plain,
               lambda df: (df["Close"] > np.percentile(df["Close"], 70)).astype(float))


def htf_left(df):
    htf = df["Close"].resample("4h", label="left").last()
    return (df["Close"] < htf.reindex(df.index, method="ffill")).astype(float)


expect_refused("leak_resample_left", fetch_plain, htf_left)


# ── leak built in fetch_data (the _add_indicators path) ─────────────────────────
def zscore_in_fetch(hdrs):
    df = fetch_plain(hdrs)
    df["z"] = (df["Close"] - df["Close"].mean()) / df["Close"].std()
    return df


expect_refused("leak_in_fetch", zscore_in_fetch, lambda df: (df["z"] > 0).astype(float))


# ── clean controls ──────────────────────────────────────────────────────────────
def sma_fetch(hdrs):
    df = fetch_plain(hdrs)
    df["f"], df["s"] = df["Close"].rolling(20).mean(), df["Close"].rolling(80).mean()
    return df


def sma_signal(df):
    sig = pd.Series(np.nan, index=df.index)      # NaN through the warm-up = hold
    sig[df["f"] > df["s"]] = 1.0
    sig[df["f"] < df["s"]] = 0.0
    return sig


expect_pass("clean_sma", sma_fetch, sma_signal, WARMUP=80)


def htf_right(df):
    htf = df["Close"].resample("4h", label="right", closed="left").last()
    at_close = htf.reindex(df.index + pd.Timedelta("1h"), method="ffill").to_numpy()
    return pd.Series(df["Close"].to_numpy() < at_close, index=df.index).astype(float)


expect_pass("clean_resample_right", fetch_plain, htf_right)


def lagged_feed_fetch(hdrs):
    from lib.data import fetch_funding_rate
    df = fetch_plain(hdrs)
    feed = fetch_funding_rate("SYN", "1d", "2025-01-01", None, hdrs)["alpha"]
    feed.index = feed.index + pd.Timedelta("1D")   # known one day after its stamp
    bar_close = pd.DataFrame({"t": df.index + pd.Timedelta("1h")}, index=df.index)
    df["feed"] = pd.merge_asof(bar_close, feed.rename("v").to_frame(), left_on="t",
                               right_index=True, direction="backward")["v"].to_numpy()
    return df


expect_pass("clean_lagged_feed", lagged_feed_fetch,
            lambda df: (df["feed"] > 0).astype(float).where(df["feed"].notna()))

expect_pass("clean_pct_change", fetch_plain,
            lambda df: (df["Close"].pct_change() > 0).astype(float))
def _raises(*a, **k):
    raise RuntimeError("delisted")


D.fetch_liquidation = _raises


def skip_on_error_fetch(hdrs):                     # a fetcher failing in the real run is skipped
    from lib.data import fetch_liquidation
    try:
        fetch_liquidation("SYN", "1h", "2025-01-01", None, hdrs)
    except Exception:
        pass
    return sma_fetch(hdrs)


refused, out, has_stats = backtest("replay_keeps_errors", skip_on_error_fetch, sma_signal, WARMUP=80)
check(refused is None and "fetch_data + compute_signals" in out,
      "a fetcher that raised in the real run raises again in the replay (fetch_data stays covered)")
refused, out, has_stats = backtest("nondeterministic", fetch_plain,
                                   lambda df: pd.Series(np.random.default_rng().integers(0, 2, len(df)),
                                                        index=df.index).astype(float))
check(refused is None and has_stats and "Look-ahead check skipped" in out,
      "nondeterministic strategy: skipped with a warning, never refused")

# ── TAIFEX settlement mask: the bar before settlement is only markable once it is not last ──
TW = pd.DatetimeIndex([d + pd.Timedelta(hours=h)
                       for d in pd.bdate_range("2025-01-01", "2025-12-31", tz="Asia/Taipei")
                       for h in (9, 10, 11, 12, 13)])
twc = 20000 * np.exp(np.cumsum(rng.normal(0, 0.003, len(TW))))
TWBARS = pd.DataFrame({"Open": twc, "High": twc * 1.002, "Low": twc * 0.998, "Close": twc,
                       "Volume": 1.0}, index=TW)


def txf_signal(df):
    sig = (df["Close"] > df["Close"].rolling(30).mean()).astype(float)
    settle = D.txf_settlement_mask(df.index)
    sig[settle] = 0.0
    return sig, settle


saved = runner.LOOKAHEAD_CUTS
runner.LOOKAHEAD_CUTS = 10**6                      # every bar after the first third is a cut
real_skip = runner._lookahead_skip_mask
no_skip = lambda r, d, i: np.zeros(len(i), dtype=bool)
expect_pass("clean_txf_settlement", lambda h: TWBARS.copy(), txf_signal)
runner._lookahead_skip_mask = no_skip
expect_pass("clean_txf_settlement_no_skip", lambda h: TWBARS.copy(), txf_signal)   # the mask itself is causal now
runner._lookahead_skip_mask = real_skip

# CME: settlement_signals_from_db marks the pre-roll bar only once the next contract is visible
CME = BARS.copy()
CME["instrument_id"] = np.repeat(np.arange(N // 200 + 1), 200)[:N]


def cme_signal(df):
    return D.settlement_signals_from_db(df, (df["Close"] > df["Close"].rolling(30).mean()).astype(float))


expect_pass("clean_cme_settlement", lambda h: CME.copy(), cme_signal)
runner._lookahead_skip_mask = no_skip
refused, _, _ = backtest("cme_without_skip", lambda h: CME.copy(), cme_signal)
check(bool(refused), "…and the settlement skip is what keeps the CME roll from reading as a look-ahead")
runner._lookahead_skip_mask = real_skip
runner.LOOKAHEAD_CUTS = saved


# ── the signal index moved to another zone than lib.data's frames ─────────────────
def taipei(df):
    df = df.copy()
    df.index = df.index.tz_localize("UTC").tz_convert("Asia/Taipei")
    return df


expect_refused("leak_after_tz_change", lambda h: taipei(fetch_plain(h)),
               lambda df: (df["Close"].shift(-1) > df["Close"]).astype(float))
expect_pass("clean_after_tz_change", lambda h: taipei(sma_fetch(h)), sma_signal, WARMUP=80)

# a naive feed stamped in Taipei wall-clock under Taipei-aware bars (the PCR shape): the
# truncation has to cut it on the wall-clock axis, not read it as UTC and cut 8h early
WALL = pd.Series(rng.normal(0, 1, len(TW)), index=TW.tz_localize(None), name="pcr")
D.fetch_twfutures_ohlcv = lambda symbol, schema, start, end, headers: TWBARS.copy()
D.fetch_twmarket_index = lambda start, end, headers, index_id="TAIEX": WALL.to_frame()


def wall_feed_fetch(hdrs):
    from lib.data import fetch_twfutures_ohlcv, fetch_twmarket_index
    df = fetch_twfutures_ohlcv("TXF", "ohlcv-1h", "2025-01-01", None, hdrs)
    feed = fetch_twmarket_index("2025-01-01", None, hdrs)["pcr"]
    df["pcr"] = feed.tz_localize("Asia/Taipei").reindex(df.index).to_numpy()
    return df


expect_pass("clean_naive_taipei_feed", wall_feed_fetch, lambda df: (df["pcr"] > 0).astype(float))

# ── Type C ──────────────────────────────────────────────────────────────────────
DIDX = pd.bdate_range("2022-01-03", periods=700)
PRICES = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (700, 6)), axis=0)),
                      index=DIDX, columns=list("ABCDEF"))


def typec(mask_fn):
    def compute(data):
        close_df, open_df = data
        sig = close_df.pct_change(20, fill_method=None)
        rank = sig.rank(axis=1, ascending=False, method="first", na_option="bottom")
        w = pd.DataFrame(np.where((rank <= 2) & sig.notna(), 0.5, 0.0),
                         index=sig.index, columns=sig.columns)
        w[~mask_fn(close_df.index)] = np.nan
        w = w.ffill().fillna(0.0)
        return w.values, pd.concat({"close": close_df, "open": open_df}, axis=1)
    return compute


def old_mask(idx):
    s = pd.Series(idx.to_period("W"), index=idx)
    return (s != s.shift(-1)).fillna(True).to_numpy()


def new_mask(idx):
    s = pd.Series(idx.to_period("W"), index=idx)
    return (s != s.shift(1)).to_numpy()


typec_fetch = lambda h: (PRICES.copy(), PRICES.copy())
refused, _, has_stats = backtest("typec_old_mask", typec_fetch, typec(old_mask), INTERVAL="1d", WARMUP=20)
check(bool(refused) and "偷看未來" in refused and "shift(1)" in refused and not has_stats,
      "Type C on the old last-bar-of-period mask: refused, message names the shift(1) fix")
expect_pass("typec_new_mask", typec_fetch, typec(new_mask), INTERVAL="1d", WARMUP=20)

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
