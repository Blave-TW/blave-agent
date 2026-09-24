"""Minimal check: Type C weight helpers shipped in the template and examples.

  - top-N with tied scores sums to exactly 1 (rank()'s default method='average' gave 1.5 for
    a top-2 of [3,3,3,1] and 0.5 for [3,2,2,2,2,1]); assets with no score get no weight
  - _rebalance_mask is causal: the mask a live tick computes on the bars it has agrees with
    the backtest's at that bar (the old "last bar of the period" mask marked every live
    last bar as a rebalance, so live rebalanced every bar while the backtest did weekly)
  - an example strategy's weights for bar t are the same with or without the bars after t
  - the runner warns on Type C rows whose gross exceeds 1 or that hold NaN

Run: cd blave-agent && .venv/bin/python tests/check_typec_template.py
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np
import pandas as pd

import lib.runner as runner

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def load(rel):
    spec = importlib.util.spec_from_file_location(rel.replace("/", "_")[:-3], os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


TEMPLATE = load("strategies/TEMPLATE_C.py")
MOMENTUM = load("examples/twstock_momentum/strategy.py")
FOREIGN = load("examples/tw100_foreign_zscore/strategy.py")

# ── ties ─────────────────────────────────────────────────────────────────────────
sig = pd.DataFrame([[3, 3, 3, 1, np.nan, np.nan],
                    [3, 2, 2, 2, 2, 1],
                    [5, np.nan, np.nan, np.nan, np.nan, np.nan]], dtype=float,
                   index=pd.bdate_range("2025-01-06", periods=3), columns=list("ABCDEF"))
w = MOMENTUM._top_n_weights(sig, 2, np.ones(3, dtype=bool))
sums = w.sum(axis=1).round(9).tolist()
check(sums[:2] == [1.0, 1.0], f"top-2 with ties sums to 1 on every row ({sums[:2]}; 'average' gave [1.5, 0.5])")
check(sums[2] == 0.5 and w.iloc[2, 1:].eq(0).all(),
      f"only one asset scored → only it gets weight, no weight on NaN scores ({w.iloc[2].tolist()})")

# ── rebalance mask causality ──────────────────────────────────────────────────────
idx = pd.bdate_range("2024-01-01", periods=260)
for name, mod in (("TEMPLATE_C", TEMPLATE), ("twstock_momentum", MOMENTUM), ("tw100_foreign_zscore", FOREIGN)):
    for freq in ("W", "M"):
        full = mod._rebalance_mask(idx, freq=freq)
        live = [bool(mod._rebalance_mask(idx[:k], freq=freq)[-1]) for k in range(2, len(idx) + 1)]
        agree = live == [bool(x) for x in full[1:]]
        per_period = pd.Series(full, index=idx).groupby(idx.to_period(freq)).sum()
        check(agree and (per_period == 1).all(),
              f"{name} _rebalance_mask({freq!r}): live mask == backtest mask at every bar, one rebalance per period")

# ── end to end: an example's weights for bar t do not depend on bars after t ─────
rng = np.random.default_rng(5)
n, cols = 400, [str(2300 + i) for i in range(8)]
didx = pd.bdate_range("2023-01-02", periods=n)
close = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (n, 8)), axis=0)), index=didx, columns=cols)
foreign = pd.DataFrame(rng.normal(0, 1000, (n, 8)).round(-2), index=didx, columns=cols)
data = (close, close.copy(), foreign)
w_full, _ = FOREIGN.compute_signals(data)
same = all(np.allclose(FOREIGN.compute_signals(tuple(d.iloc[:k] for d in data))[0][-1], w_full[k - 1])
           for k in range(150, n, 7))
check(same, "tw100_foreign_zscore: weights at bar t identical with or without later bars (live == backtest)")

partial = foreign.drop(columns=cols[5:])        # three stocks have no flow data at all
w_part, p_part = FOREIGN.compute_signals((close, close.copy(), partial))
w_df = pd.DataFrame(w_part, index=didx, columns=p_part["close"].columns) if w_part.shape == close.shape else None
check(w_df is not None and (w_df[cols[5:]] == 0).all().all() and w_df[cols[:5]].abs().sum().sum() > 0,
      f"tw100_foreign_zscore: weight columns line up with price_df, stocks without flow data weigh 0 "
      f"(weights {w_part.shape} vs prices {close.shape})")

# ── runner warning on bad rows ───────────────────────────────────────────────────
bad = np.array([[0.5, 0.5, 0.5, 0.0], [0.5, 0.5, 0.0, 0.0], [np.nan, 0.5, 0.0, 0.0]])
msgs = runner._weight_row_warnings(bad, didx[:3])
check(len(msgs) == 2 and any("above 1" in m for m in msgs) and any("NaN" in m for m in msgs),
      "runner flags a 1.5 row and a NaN row")
check(runner._weight_row_warnings(bad[1:2], didx[:1]) == [], "a clean row sums to 1 → no warning")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
