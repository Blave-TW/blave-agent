"""Minimal check: every backtest runs the truncation-invariance (look-ahead) check and refuses
a strategy whose past positions change when later bars are removed.

Drives the real lib/runner.run() in backtest mode in a temp workspace — no network: the
lib.data fetchers a strategy calls are replaced with synthetic ones.

  refused (「偷看未來」, no stats.json): shift(-1), bfill, full-sample z-score, full-sample
    percentile, resample(label='left') — in compute_signals, plus a full-sample z-score
    built in fetch_data (_add_indicators path, caught through the lib.data replay) and a
    Type C portfolio on the old `(s != s.shift(-1)).fillna(True)` rebalance mask
    and the same shift(-1) after fetch_data moved the index from naive UTC to Asia/Taipei
  refused on every setting (default, one pool cut, budget already spent), naming the missing
    column: Type C ranking factors across a stock that has data before it lists, masked afterwards
  passes: SMA cross with warm-up NaNs (also after that zone change), a correct label='right'
    higher timeframe, an external daily feed aligned with its publication lag, a naive
    Taipei-wall-clock feed under Taipei-aware bars, TAIFEX
    settlement-masked bars, CME settlement_signals_from_db bars, Type C on the
    first-bar-of-period mask, the same factor ranking masked before it ranks
  passes: a US daily feed with holidays aligned onto 24/7 daily bars (the bars align_feed cut
    at a holiday are excused; any other bar missing from a truncated run still counts)
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

# ── Type C: a cross-sectional rank that counts a stock before it listed ─────────────────────
# Z has fundamentals for its whole history but prices only from bar LIST_AT (the 3447 / 6614
# shape). A truncated replay before LIST_AT drops Z's column; ranking the factors before masking
# by `valid` lets Z move everyone else's percentile in the full run. The pool cut that would
# catch it is a lottery (LIST_AT sits just above the pool's lower bound, and a slow strategy runs
# one cut) — the column-set cut must refuse it on every setting.
SIDS, LIST_AT = list("ABCDEFGHIJK") + ["Z"], 240
frng = np.random.default_rng(11)
PX = {s: pd.DataFrame({"Open": PRICES["A"].to_numpy() * (1 + frng.normal(0, 0.01, 700)),
                       "Close": PRICES["B"].to_numpy() * (1 + frng.normal(0, 0.01, 700))}, index=DIDX)
      for s in SIDS}
PX["Z"] = PX["Z"].iloc[LIST_AT:]
FAC = {s: pd.DataFrame({"f1": frng.normal(size=700), "f2": frng.normal(size=700)}, index=DIDX) for s in SIDS}
# two dict-per-symbol batch fetchers outside FEED_TIMING: the replay cuts them by stamp, so the
# only thing a truncation changes is which symbols exist
D.fetch_kline_batch = lambda ids, interval, start, end, headers: {s: PX[s].copy() for s in ids}
D.fetch_twstock_dividend_batch = lambda ids, start, end, headers: {s: FAC[s].copy() for s in ids}


def listing_fetch(hdrs):
    from lib.data import fetch_kline_batch, fetch_twstock_dividend_batch
    px = fetch_kline_batch(SIDS, "1d", "2022-01-03", None, hdrs)
    fa = fetch_twstock_dividend_batch(SIDS, "2022-01-03", None, hdrs)
    closes, opens, f1, f2 = {}, {}, {}, {}
    for s in SIDS:
        p = px.get(s)
        if p is None or p.empty:
            continue
        closes[s], opens[s], f1[s], f2[s] = p["Close"], p["Open"], fa[s]["f1"], fa[s]["f2"]
    close_df = pd.DataFrame(closes).sort_index()
    at = lambda d: pd.DataFrame(d).reindex(close_df.index)
    return close_df, at(opens), at(f1), at(f2)


def factor_basket(mask_first):
    def compute(data):
        close_df, open_df, f1, f2 = data
        valid = close_df.notna() & f1.notna() & f2.notna()
        if mask_first:
            f1, f2 = f1.where(valid), f2.where(valid)
        score = ((f1.rank(axis=1, pct=True) + f2.rank(axis=1, pct=True)) / 2).where(valid)
        rank = score.rank(axis=1, ascending=False, method="first", na_option="bottom")
        w = pd.DataFrame(np.where((rank <= 3) & score.notna(), 1 / 3, 0.0),
                         index=score.index, columns=score.columns)
        w[~new_mask(close_df.index)] = np.nan
        return w.ffill().fillna(0.0).values, pd.concat({"close": close_df, "open": open_df}, axis=1)
    return compute


class SlowClock:
    """Every monotonic() read is 40 s later: compute_signals measures 40 s (under the skip
    threshold) and the budget is spent before the second cut — the 13:36 one-cut pass."""
    def __init__(self):
        self.n = 0

    def monotonic(self):
        self.n += 1
        return 40.0 * self.n

    def __getattr__(self, name):
        return getattr(runner_time, name)


runner_time, saved_cuts = runner.time, runner.LOOKAHEAD_CUTS
for tag, cuts, clock in (("default", saved_cuts, runner_time), ("one pool cut", 1, runner_time),
                         ("budget spent", saved_cuts, None)):
    runner.LOOKAHEAD_CUTS = cuts
    slug = tag.replace(" ", "_")
    runner.time = clock or SlowClock()
    refused, out, has_stats = backtest(f"typec_rank_before_listing_{slug}", listing_fetch,
                                       factor_basket(False), INTERVAL="1d", WARMUP=20)
    check(bool(refused) and "偷看未來" in refused and not has_stats
          and "1 column(s) exist in the full data but not at the cut, e.g. Z" in refused
          and "did not exist yet" in refused,
          f"Type C ranking a not-yet-listed stock ({tag}): refused, message names the missing column"
          + ("" if refused else " — it passed: " + next((l for l in out.splitlines() if "Look-ahead" in l), "")))
    runner.time = clock or SlowClock()
    expect_pass(f"typec_mask_before_rank_{slug}", listing_fetch, factor_basket(True), INTERVAL="1d", WARMUP=20)
runner.time, runner.LOOKAHEAD_CUTS = runner_time, saved_cuts

refused, out, _ = backtest("typec_mask_before_rank_report", listing_fetch, factor_basket(True), INTERVAL="1d", WARMUP=20)
check(refused is None and "dropped not-yet-listed symbols" in out,
      "the pass line says the symbol-set cut dropped a symbol")

# a cut that keeps every column proves nothing about ranking before listing — the pass line
# must not claim it: (1) the strategy reindexes to a fixed universe, (2) a row-truncated replay
def listing_fetch_fixed_universe(hdrs):
    from lib.data import fetch_kline_batch, fetch_twstock_dividend_batch
    px = fetch_kline_batch(SIDS, "1d", "2022-01-03", None, hdrs)
    fa = fetch_twstock_dividend_batch(SIDS, "2022-01-03", None, hdrs)
    close_df = pd.DataFrame({s: px[s]["Close"] for s in SIDS}).sort_index().reindex(columns=SIDS)
    at = lambda col, src: pd.DataFrame({s: src[s][col] for s in SIDS}).reindex(close_df.index)
    return close_df, at("Open", px), at("f1", fa), at("f2", fa)


refused, out, _ = backtest("typec_fixed_universe", listing_fetch_fixed_universe, factor_basket(False),
                           INTERVAL="1d", WARMUP=20)
check(refused is None and "did not take effect" in out and "dropped not-yet-listed" not in out
      and "⚠️ Look-ahead check passed with a gap — NOT verified" in out and "Look-ahead check: passed" not in out,
      "universe reindexed to a fixed list: passes, but says the symbol-set check did not take effect")
runner._FetchRecorder.usable = property(lambda self: False, lambda self, v: None)   # instance attr → forced off
refused, out, _ = backtest("typec_compute_only", listing_fetch, factor_basket(False), INTERVAL="1d", WARMUP=20)
del runner._FetchRecorder.usable
check(refused is None and "compute_signals only" in out and "did not take effect" in out
      and "⚠️ Look-ahead check passed with a gap — NOT verified" in out,
      "compute-only replay: says the symbol-set check did not take effect")


# the symbol-set cut fails to run (strategy needs more history): the pool cuts still count
def needs_history(compute, bars):
    def wrapped(data):
        if len(data[0]) < bars:
            raise ValueError(f"need {bars} bars")
        return compute(data)
    return wrapped


refused, out, has_stats = backtest("typec_needs_300", listing_fetch, needs_history(factor_basket(True), 300),
                                   INTERVAL="1d", WARMUP=20)
check(refused is None and has_stats and "⚠️ Look-ahead check passed with a gap — NOT verified" in out and "Look-ahead check: passed" not in out
      and "the symbol-set cut failed to run: need 300 bars" in out,
      "symbol-set cut fails to run: annotated pass on the pool cuts, error named")


# a weight held on a symbol before it existed: the moved column is the missing one → "possibly"
def hold_z(data):
    close_df, open_df, _, _ = data
    w = pd.DataFrame(0.0, index=close_df.index, columns=close_df.columns)
    if "Z" in w:
        w["Z"] = 1.0
    return w.values, pd.concat({"close": close_df, "open": open_df}, axis=1)


refused, _, _ = backtest("typec_hold_before_listing", listing_fetch, hold_z, INTERVAL="1d", WARMUP=20)
check(bool(refused) and "[Z]" in refused and "e.g. Z — possibly" in refused,
      "weight on the missing symbol itself: refused, the rank rule worded as 'possibly'")

# _lookahead_column_cuts on every shape compute_signals may hand it
cc = pd.DataFrame({"A": PX["A"]["Close"], "Z": PX["Z"]["Close"]}).reindex(DIDX)
noskip = np.zeros(len(DIDX), dtype=bool)
w2 = np.zeros((len(DIDX), 2))
shapes = {"multi": pd.concat({"close": cc, "open": cc}, axis=1), "no close level": cc,
          "dict": {"close": cc}, "ndarray": cc.values, "empty": pd.concat({"close": cc.iloc[:, :0]}, axis=1),
          "all-NaN column": pd.concat({"close": cc.assign(C=np.nan)}, axis=1)}
want = {"multi": [LIST_AT], "no close level": [], "dict": [LIST_AT], "ndarray": [], "empty": [],
        "all-NaN column": [LIST_AT]}
for name, pdf in shapes.items():
    try:
        got = runner._lookahead_column_cuts((w2, pdf), (cc,), DIDX, 40, 233, noskip)[0]
    except Exception as e:
        got = f"raised {e!r}"
    check(got == want[name], f"column cuts on {name}: {got}")
check(runner._lookahead_column_cuts(("not Type C", cc), (cc,), DIDX, 40, 233, noskip)[0] == [],
      "column cuts on a Type A result: none")
sk = noskip.copy()
sk[LIST_AT - 1] = sk[LIST_AT - 2] = True
check(runner._lookahead_column_cuts((w2, shapes["multi"]), (cc,), DIDX, 40, 233, sk)[0] == [LIST_AT - 2],
      "a settlement bar steps the column cut earlier")
sk = noskip.copy()
sk[225:LIST_AT] = True
check(runner._lookahead_column_cuts((w2, shapes["multi"]), (cc,), DIDX, 40, 233, sk)[0] == [],
      "a pick above the pool floor never steps below it")
check(runner._lookahead_column_cuts((w2, shapes["multi"]), (cc,), DIDX, 40, 300, noskip)[0] == [LIST_AT],
      "every start below the pool floor: the latest one is still cut (floor = WARMUP+20)")
fac = cc.copy()
fac["Z"] = 1.0
check(runner._lookahead_column_cuts((w2, shapes["multi"]), (cc, fac), DIDX, 40, 233, noskip)[0] == [LIST_AT],
      "a symbol with data before its first priced bar: cut right at that bar")
check(runner._lookahead_column_cuts((w2, shapes["multi"]), ("junk", {"x": [fac]}, None), DIDX, 40, 233, noskip)[0]
      == [LIST_AT], "fetch_data frames found inside lists / dicts")
bad = fac.iloc[[0, 0, 1]]                                    # shares columns, duplicated index → reindex raises
cuts, notes = runner._lookahead_column_cuts((w2, shapes["multi"]), (cc, bad, fac), DIDX, 40, 233, noskip)
check(cuts == [LIST_AT] and len(notes) == 1 and "frame #2 skipped" in notes[0],
      f"an unreadable frame is skipped and noted, the others still place the cut: {cuts} {notes}")
cuts, notes = runner._lookahead_column_cuts((w2, shapes["multi"]), (bad,), DIDX, 40, 233, noskip)
check(cuts == [LIST_AT] and len(notes) == 1, "…and with only that frame the fallback pick survives")

# budget spent after the first cut: the column cut AND "drop the last bar" still both run
runner.time = SlowClock()
refused, out, _ = backtest("typec_budget_last_bar", listing_fetch, factor_basket(True), INTERVAL="1d", WARMUP=20)
runner.time = runner_time
check(refused is None and "passed (2 truncation point(s)" in out,
      "budget spent: the column cut and the last-bar cut both run"
      + ("" if refused else " — " + next((l for l in out.splitlines() if "Look-ahead" in l), "")))

# the real shape (2026-10-03 run): the stock with pre-listing fundamentals is neither the latest
# lister nor the earliest past the pool floor — W lists at 250 and Y at 650 with no early data,
# Z has fundamentals from 300 and prices from 500. Only a cut in (300, 500] can see Z; the
# column-set pick must find it from the data, not from where columns start.
saved_px = PX, FAC, SIDS
PX, FAC = dict(PX), dict(FAC)
SIDS = SIDS + ["W", "Y"]
PX["Z"] = PX["A"].iloc[500:] * 1.01
PX["W"], PX["Y"] = PX["B"].iloc[250:] * 1.02, PX["C"].iloc[650:] * 1.03
FAC["Z"] = FAC["A"].iloc[300:] * -1
FAC["W"], FAC["Y"] = FAC["B"].iloc[250:] + 0.1, FAC["C"].iloc[650:] - 0.1
runner.LOOKAHEAD_CUTS = 1
refused, out, _ = backtest("typec_phantom_mid_history", listing_fetch, factor_basket(False), INTERVAL="1d", WARMUP=20)
check(bool(refused) and "not at the cut, e.g. Z" in refused,
      "pre-listing data mid-history, neither latest nor earliest lister: refused, Z named"
      + ("" if refused else " — " + next((l for l in out.splitlines() if "Look-ahead" in l), "")))
expect_pass("typec_phantom_mid_history_masked", listing_fetch, factor_basket(True), INTERVAL="1d", WARMUP=20)
runner.LOOKAHEAD_CUTS = saved_cuts
PX, FAC, SIDS = saved_px

# ── a US daily feed under 24/7 crypto bars: a US holiday has no row, ever ────────────────────────
# Full run: the bars after a holiday are NaN mid-history (held). A truncation that ends there:
# align_feed cuts those bars (due row not in the data). Live refuses them too, so they are not a
# look-ahead — the replay excuses exactly the bars align_feed cut, nothing else.
US_DAYS = pd.bdate_range("2024-01-01", "2025-12-31")
US_DAYS = US_DAYS[US_DAYS.dayofweek != 4]          # every Friday a "holiday": 52 a year, so any cut can land on one
US = pd.DataFrame({"Close": 100 + np.cumsum(rng.normal(0, 1, len(US_DAYS)))}, index=US_DAYS)
DAILY = pd.date_range("2024-06-01", "2025-12-31", freq="1D")
BTC_D = pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": 100 * np.exp(np.cumsum(rng.normal(0, 0.02, len(DAILY)))),
                      "Volume": 1.0}, index=DAILY)
D.fetch_usstock_price = lambda symbol, start, end, headers=None: US.copy()


def us_filter_fetch(hdrs):
    from lib.data import fetch_usstock_price, align_feed
    df = BTC_D.copy()
    rel = (fetch_usstock_price("SPY", "2024-01-01", None)["Close"].rolling(20).mean()).rename("rel").to_frame().dropna()
    al = align_feed(df, rel, "usstock_price", "1d", bar_tz="UTC")
    return df.loc[al.index].join(al)


def us_filter_signal(df):
    sig = (df["rel"].diff() > 0).astype(float)
    return sig.where(df["rel"].notna() & df["rel"].shift(1).notna())   # NaN (holiday) = hold


refused, out, has_stats = backtest("us_holiday_feed", us_filter_fetch, us_filter_signal, INTERVAL="1d", WARMUP=5)
check(refused is None and has_stats and "Look-ahead check: passed" in out and "set to NaN" in out,
      "US feed with holidays under daily crypto bars: passes (the bars align_feed cut at a holiday are excused)"
      + (f" — got {refused[:200]!r}" if refused else ""))
d = runner._lookahead_diff(pd.Series([1.0, 1.0, 1.0], index=IDX[:3]), pd.Series([1.0], index=IDX[:1]), IDX[3],
                           excused=pd.DatetimeIndex([IDX[1]]))
check(d is not None and d[0] == IDX[2],
      "a bar missing from the truncated run that align_feed did NOT cut still counts as a difference")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
