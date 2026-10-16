"""Minimal check: the 0.1.26 Type C random-portfolio benchmark (lib/analysis.py).

1. n_held=None, and any N ≥ (S+1)/2 (α capped at 1), reproduce the pre-0.1.26 formula
   (embedded below) digit for digit.
2. α = bench_alpha(N, S): the draws' median effective holdings 1/Σw² ≈ N.
3. held_count: median names held on the rows count_trades counts as trades.
4. benchmark_band: p5 ≤ … ≤ p95, one point per daily_returns_typeC date (intraday bars
   across weekends too), and a non-finite price drops the band instead of shipping NaN.
No network.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_bench_band.py
"""
import contextlib
import io
import os
import sys
import warnings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from lib.analysis import (bench_alpha, compute_stats, count_trades, held_count,  # noqa: E402
                          random_bh_benchmark)
from lib.pnl import daily_returns_typeC  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def old_benchmark(close_df, strat_total_ret, strat_sharpe, n=1000, seed=42):
    """lib/analysis.random_bh_benchmark as of 872f591 (stats only)."""
    daily_ret = close_df.pct_change().fillna(0).values
    W = np.random.default_rng(seed).dirichlet(np.ones(daily_ret.shape[1]), size=n)
    rets, sharpes = [], []
    for col in (daily_ret @ W.T).T:
        s, _, _, _, _ = compute_stats(col, close_df.index)
        rets.append((np.cumprod(1 + np.nan_to_num(col))[-1] - 1) * 100)
        sharpes.append(s)
    r, sh = pd.Series(rets), pd.Series(sharpes)
    return {
        'benchmark_n': n,
        'benchmark_median_ret_%': round(float(r.median()), 2),
        'benchmark_p5_ret_%': round(float(r.quantile(.05)), 2),
        'benchmark_p95_ret_%': round(float(r.quantile(.95)), 2),
        'benchmark_median_sharpe': round(float(sh.median()), 3),
        'benchmark_strategy_ret_pct': round(float((r < strat_total_ret).mean() * 100), 1),
        'benchmark_strategy_sharpe_pct': round(float((sh < strat_sharpe).mean() * 100), 1),
    }


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def prices(T, S, freq, seed):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2024-01-05", periods=T, freq=freq)
    return pd.DataFrame(np.cumprod(1 + rng.normal(0.0002, 0.01, (T, S)), axis=0) * 100,
                        index=idx, columns=[f"S{i}" for i in range(S)])


# ── 1. α = 1 is the old benchmark, bit for bit ──────────────────────────────
close = prices(600, 8, "D", 1)
ref = old_benchmark(close, 30.0, 0.8)
for n_held, label in ((None, "n_held=None"), (4.5, "N=(S+1)/2"), (8.0, "N=S")):
    st, _ = quiet(random_bh_benchmark, close, 30.0, 0.8, bands=False, n_held=n_held)
    check({k: st[k] for k in ref} == ref, f"{label}: α={bench_alpha(n_held, 8)} → stats identical to 872f591")
check(bench_alpha(1, 20) > 0 and bench_alpha(0, 20) > 0, "N ≤ 1 keeps α > 0 (floor)")

# ── 2. median 1/Σw² of the draws ≈ N ────────────────────────────────────────
for S, N in ((20, 2), (20, 5), (100, 10), (1700, 30), (1700, 100)):
    a = bench_alpha(N, S)
    W = np.random.default_rng(42).dirichlet(np.full(S, a), size=1000)
    eff = float(np.median(1 / (W ** 2).sum(axis=1)))
    check(abs(eff - N) / N < 0.15, f"S={S} N={N}: α={a:.4g}, median effective holdings {eff:.2f}")

# ── 3. held_count follows count_trades' rebalance rows ──────────────────────
w = np.zeros((10, 4))
w[2:5, :2] = 0.5             # hold 2 from row 2
w[5:8, :] = 0.25             # hold 4 from row 5
w[6, 0] = 0.25 + 1e-6        # sub-4dp noise: not a trade, not a rebalance row
w[8:, :1] = 1.0              # hold 1 from row 8
w_curr = np.vstack([np.zeros((1, 4)), w[:-1]])
w_prev = np.vstack([np.zeros((2, 4)), w[:-2]])
dw = w_curr - w_prev
rows = (np.round(dw, 4) != 0).any(axis=1)
check(int(rows.sum()) == 3 and count_trades(dw) > 0, f"3 rebalance rows ({int(rows.sum())})")
check(held_count(dw, w_curr) == 2.0, f"median held of [2, 4, 1] = 2 ({held_count(dw, w_curr)})")
check(held_count(np.zeros((5, 3)), np.zeros((5, 3))) is None, "never rebalanced → None (α = 1)")

# ── 4. band shape, alignment, monotone, non-finite ──────────────────────────
for T, S, freq, n_held in ((24 * 40, 6, "h", 2.0), (500, 3, "B", None), (300, 12, "D", 3.0)):
    close = prices(T, S, freq, T)
    st, _ = quiet(random_bh_benchmark, close, 10.0, 0.5, n=200, bands=False, n_held=n_held)
    b = st.get("benchmark_band") or {}
    dates, _ = daily_returns_typeC(pd.Series(0.0, index=close.index))
    qs = ["p5", "p25", "p50", "p75", "p95"]
    check(sorted(b) == sorted(qs) and all(len(b[q]) == len(dates) for q in qs),
          f"{freq} T={T}: five series, each len == daily_dates ({len(dates)})")
    arr = np.array([b[q] for q in qs])
    check(bool((np.diff(arr, axis=0) >= 0).all()) and bool(np.isfinite(arr).all()),
          f"{freq} T={T}: p5 ≤ … ≤ p95 everywhere, all finite")
    full, _ = quiet(random_bh_benchmark, close, 10.0, 0.5, n=200, bands=True, n_held=n_held)
    check(full == st, f"{freq} T={T}: bands=True writes the same stats + band")

bad = prices(200, 4, "D", 7)
bad.iloc[50:60, 1] = 0.0     # 0 → next pct_change is inf
with np.errstate(all="ignore"), warnings.catch_warnings():
    warnings.simplefilter("ignore")
    st, _ = quiet(random_bh_benchmark, bad, 10.0, 0.5, n=100, bands=False)
check("benchmark_band" not in st, "an inf return drops benchmark_band (no NaN reaches the api)")

print("FAILED" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
