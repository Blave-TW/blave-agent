"""Minimal check: a Type C (portfolio) backtest's stats.json carries every key the web
workspace report reads (web/app/main/templates/agent/workspace.html › buildBtMeta /
buildBtStats), under the same names Type A uses — the report showed 「手續費 —」 and a blank
Sortino / Omega for portfolios because Type C wrote `fee` instead of `fee [%]` and dropped
the two ratios. Sortino / Omega must match lib.analysis.compute_stats on the portfolio's own
per-bar returns.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typec_stats_keys.py
"""
import contextlib
import io
import json
import math
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.runner as runner
from lib.analysis import compute_stats, precise_pnl

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


# what the report reads — header row + the three metric groups + the equity / benchmark rows
REPORT_KEYS = ["start", "end", "interval", "fee [%]", "Total Return [%]", "Ann. Return [%]",
               "Max Drawdown [%]", "Sharpe Ratio", "Sortino Ratio", "Omega Ratio", "Trades",
               "Total Fees Paid [%]", "daily_dates", "daily_returns", "Generated At"]
BENCHMARK_KEYS = ("Benchmark Return [%]", "benchmark_strategy_ret_pct")   # Type A / Type C random shape; Taiwan Type C (benchmark_bh): check_typec_tw_benchmark

WS = Path(tempfile.mkdtemp(prefix="typec-keys-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(9)
IDX = pd.bdate_range("2023-01-02", periods=500)
CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, (500, 5)), axis=0)),
                     index=IDX, columns=list("ABCDE"))
OPEN = CLOSE.shift(1).fillna(CLOSE.iloc[0]) * (1 + rng.normal(0, 0.002, CLOSE.shape))
FEE = 0.003


def compute(data):
    c, o = data
    mom = c.pct_change(20, fill_method=None)
    rank = mom.rank(axis=1, ascending=False, method="first", na_option="bottom")
    w = pd.DataFrame(np.where((rank <= 2) & mom.notna(), 0.5, 0.0), index=c.index, columns=c.columns)
    s = pd.Series(c.index.to_period("W"), index=c.index)
    w[~(s != s.shift(1)).to_numpy()] = np.nan
    return w.ffill().fillna(0.0).values, pd.concat({"close": c, "open": o}, axis=1)


with contextlib.redirect_stdout(io.StringIO()):
    runner.run({"STRATEGY_NAME": "pf", "INTERVAL": "1d", "START": "2023-01-02", "FEE": FEE, "WARMUP": 20},
               lambda h: (CLOSE.copy(), OPEN.copy()), compute)
st = json.loads((WS / "strategies" / "pf" / "stats.json").read_text())

missing = [k for k in REPORT_KEYS if st.get(k) is None]
check(not missing, f"Type C stats.json has every key the report reads, non-null (missing: {missing})")
check(any(isinstance(st.get(k), (int, float)) for k in BENCHMARK_KEYS),
      "Type C stats.json has a benchmark figure the report can show")
check(st.get("fee [%]") == round(FEE * 100, 4), f"fee [%] = FEE × 100 like Type A ({st.get('fee [%]')})")

w, price_df = compute((CLOSE, OPEN))
w, price_df = w[20:], price_df.iloc[20:]
k = w.shape[1]
w_curr = np.vstack([np.zeros((1, k)), w[:-1]])
w_prev = np.vstack([np.zeros((2, k)), w[:-2]])
pf_ret, *_ = precise_pnl(price_df["close"].values, price_df["open"].values, w_curr, w_prev,
                         np.zeros(len(w), dtype=bool), FEE)
_, sortino, omega, _, _ = compute_stats(pf_ret, price_df.index)
check(math.isclose(st["Sortino Ratio"], round(sortino, 4), abs_tol=1e-4)
      and math.isclose(st["Omega Ratio"], round(omega, 4), abs_tol=1e-4),
      f"Sortino / Omega from the portfolio's own returns ({st['Sortino Ratio']} / {st['Omega Ratio']} "
      f"vs {sortino:.4f} / {omega:.4f})")



def band_ok(stats, label):
    """benchmark_band per the 0.1.26 contract: five series, each as long as daily_dates,
    p5 ≤ … ≤ p95 at every point, last point = the benchmark_* return columns."""
    b = stats.get("benchmark_band") or {}
    keys = ["p5", "p25", "p50", "p75", "p95"]
    n = len(stats.get("daily_dates") or [])
    check(sorted(b) == sorted(keys) and all(len(b[q]) == n for q in keys) and n > 0,
          f"{label}: benchmark_band has p5…p95, each as long as daily_dates ({n})")
    check(all(b[a][i] <= b[c][i] for a, c in zip(keys, keys[1:]) for i in range(n)),
          f"{label}: benchmark_band p5 ≤ p25 ≤ p50 ≤ p75 ≤ p95 at every point")
    ends = [(b["p5"][-1], "benchmark_p5_ret_%"), (b["p50"][-1], "benchmark_median_ret_%"),
            (b["p95"][-1], "benchmark_p95_ret_%")]
    check(all(abs((v - 1) * 100 - stats[k]) <= 0.0051 for v, k in ends),
          f"{label}: band end − 1 = benchmark p5 / median / p95 return "
          f"({[round((v - 1) * 100, 2) for v, _ in ends]} vs {[stats[k] for _, k in ends]})")
    # compute() holds the top 2 of 5 → α = (2−1)/(5−2)
    check(stats.get("benchmark_method") == "dirichlet_eff_n" and stats.get("benchmark_eff_n") == 2.0,
          f"{label}: benchmark_method / eff_n ({stats.get('benchmark_method')}, {stats.get('benchmark_eff_n')})")


band_ok(st, "backtest")

# no market fields (the 0.1.12 venue check was dropped before release): a performance refresh of a
# live strategy (a live tick itself does not touch stats.json) neither carries a stale `market` /
# `market_symbols` left in stats.json nor records a new one
st["market"] = "crypto_perp:binance"
st["market_symbols"] = ["A", "B", "C", "D", "E"]
(WS / "strategies" / "pf" / "stats.json").write_text(json.dumps(st))
LIVE = CLOSE.rename(columns={"E": "XAUUSDT"})
os.environ["BLAVE_MODE"] = "live"
os.environ[runner.STATS_REFRESH_ENV] = "1"
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run({"STRATEGY_NAME": "pf", "INTERVAL": "1d", "START": "2023-01-02", "FEE": FEE, "WARMUP": 20},
                   lambda h: (LIVE.copy(), OPEN.rename(columns={"E": "XAUUSDT"}).copy()), compute)
finally:
    os.environ["BLAVE_MODE"] = "backtest"
    os.environ.pop(runner.STATS_REFRESH_ENV, None)
lv = json.loads((WS / "strategies" / "pf" / "stats.json").read_text())
check("market" not in lv and "market_symbols" not in lv,
      f"performance refresh: no market / market_symbols carried or recorded ({lv.get('market')}, {lv.get('market_symbols')})")
band_ok(lv, "performance refresh")

# Type A writes the same report keys (Ann. Return is derived by the report when absent)
with contextlib.redirect_stdout(io.StringIO()):
    runner.run({"STRATEGY_NAME": "single", "SYMBOL": "A", "INTERVAL": "1d", "START": "2023-01-02",
                "FEE": FEE, "MCPT": False},
               lambda h: pd.DataFrame({"Open": OPEN["A"], "High": CLOSE["A"], "Low": CLOSE["A"],
                                       "Close": CLOSE["A"], "Volume": 1.0}),
               lambda df: (df["Close"] > df["Close"].rolling(20).mean()).astype(float))
sa = json.loads((WS / "strategies" / "single" / "stats.json").read_text())
check(not [k for k in REPORT_KEYS if k != "Ann. Return [%]" and k not in sa],
      "Type A stats.json carries the same report keys (reference shape)")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
