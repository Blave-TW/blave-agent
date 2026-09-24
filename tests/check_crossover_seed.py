"""Minimal check: a crossover strategy that starts inside a trend enters on the first bar its
averages exist, not at the first cross months later.

examples/tsmc_ma is event-based (1.0 / 0.0 only on the cross bar, NaN = hold). Before the fix
a backtest whose warm-up ended with the fast line already above the slow one sat flat until a
death cross and then a golden cross had both happened. The seed must survive the runner's
Type A path (lib/runner.py: signals.iloc[WARMUP:] then ffill), so it is checked through
runner._lookahead_positions, not just on the raw series. examples/btc_sma_cross is state-based
(a value on every bar) and is the reference the event-based form must match bar for bar.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_crossover_seed.py
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def load(rel):
    spec = importlib.util.spec_from_file_location(rel.split("/")[1], os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


TSMC = load("examples/tsmc_ma/strategy.py")
BTC = load("examples/btc_sma_cross/strategy.py")
FAST, SLOW = 5, 60
IDX = pd.bdate_range("2023-01-02", periods=260)


def frame(up_first):
    # 130 bars of trend one way, then 130 the other: the fast line is on the trend's side
    # from the first bar both averages exist, and the first cross comes ~bar 140.
    a, b = (100, 180) if up_first else (180, 100)
    c = np.r_[np.linspace(a, b, 130), np.linspace(b, a, 130)]
    return pd.DataFrame({"Open": c, "High": c, "Low": c, "Close": c}, index=IDX)


for up_first, want in ((True, 1.0), (False, 0.0)):
    df = frame(up_first)
    first = df["Close"].rolling(SLOW).mean().first_valid_index()
    label = "fast above slow" if up_first else "fast below slow"
    for name, mod in (("tsmc_ma", TSMC), ("btc_sma_cross", BTC)):
        sig = mod.compute_signals(df, FAST, SLOW)
        check(sig.first_valid_index() == first and sig[first] == want,
              f"{name}, start {label}: first signal on the slow line's first valid bar "
              f"({first.date()}) = {want}")
        pos = runner._lookahead_positions(sig, mod.WARMUP)
        check(float(pos.iloc[0]) == want,
              f"{name}, start {label}: the first bar the runner trades on (after WARMUP="
              f"{mod.WARMUP}) holds {want}, not flat")

    tsmc, btc = TSMC.compute_signals(df, FAST, SLOW), BTC.compute_signals(df, FAST, SLOW)
    check(tsmc.ffill().fillna(0).equals(btc.ffill().fillna(0)),
          f"start {label}: event-based tsmc_ma and state-based btc_sma_cross give the same "
          f"position on every bar")
    f, s = df["Close"].rolling(FAST).mean(), df["Close"].rolling(SLOW).mean()
    cross = ((f > s) != (f > s).shift(1)) & s.notna() & s.shift(1).notna()
    first_cross = cross[cross].index[0]
    after = tsmc.loc[first_cross:]
    check(tsmc[first_cross] == (1.0 - want) and after.notna().sum() < len(after) // 2
          and after.dropna().index.isin(cross[cross].index).all(),
          f"start {label}: after the first cross ({first_cross.date()}) tsmc_ma only marks the "
          f"cross bars ({int(after.notna().sum())} of {len(after)} bars), hold elsewhere")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
