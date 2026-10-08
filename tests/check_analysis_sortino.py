"""lib.analysis.compute_stats — Sortino uses the textbook downside deviation.

Denominator = sqrt(mean(min(r - MAR, 0)^2)) over ALL bars, MAR = 0 (Sortino & van der Meer;
empyrical.downside_risk; Rollinger & Hoffman 2013 call the alternative — std of the losing
bars only — the most common wrong implementation, and gs-quant issue #388 is that bug).
The old lib did exactly that: `r[r < 0].std(ddof=1)`, which shrinks with every flat bar
and returns 0 when every loss has the same size. Every golden value below is hand-computed
and differs from what the old formula gives, so reverting the fix turns this red.

Run: cd blave-agent && .venv/bin/python tests/check_analysis_sortino.py
"""
import json
import math
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib.analysis import compute_stats, periods_per_year

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def idx_ppy1(n):
    """n bars whose first→last span is n × 365.25 days → periods_per_year == 1 exactly,
    so the golden numbers are mean / downside_dev with no annualisation factor."""
    span = n * 365.25
    assert span == int(span), "pick n as a multiple of 4"
    t0 = pd.Timestamp("2020-01-01")
    return pd.DatetimeIndex([t0 + pd.Timedelta(days=i) for i in range(n - 1)] + [t0 + pd.Timedelta(days=span)])


# ---- three golden sets (ppy = 1, MAR = 0) -------------------------------------------
# set 1: r = [.02, -.01, .03, -.02]
#   mean = .02/4 = .005; shortfall² = [0, 1e-4, 0, 4e-4] → mean 1.25e-4 → dd = .0111803
#   sortino = .005/.0111803 = .4472136           (old: std([-.01,-.02]) = .0070711 → .7071)
# set 2: flat bars count — r = [.01, 0, 0, -.01, 0, 0, .02, -.03]
#   mean = -.01/8 = -.00125; shortfall² sum = 1e-4 + 9e-4 = 1e-3 → mean 1.25e-4 → dd = .0111803
#   sortino = -.00125/.0111803 = -.1118034       (old: std([-.01,-.03]) = .0141421 → -.0884)
# set 3: r = [.05, -.02, 0, .01, -.04, .02, -.01, .03]
#   mean = .04/8 = .005; shortfall² sum = 4e-4 + 16e-4 + 1e-4 = 21e-4 → mean 2.625e-4 → dd = .0162019
#   sortino = .005/.0162019 = .3086067           (old: std([-.02,-.04,-.01]) = .0152753 → .3273)
GOLDEN = [
    ("set 1: two losses of different size",      [0.02, -0.01, 0.03, -0.02],                          0.4472136),
    ("set 2: flat bars stay in the denominator", [0.01, 0.0, 0.0, -0.01, 0.0, 0.0, 0.02, -0.03],     -0.1118034),
    ("set 3: mixed",                             [0.05, -0.02, 0.0, 0.01, -0.04, 0.02, -0.01, 0.03],  0.3086067),
]
for label, r, want in GOLDEN:
    idx = idx_ppy1(len(r))
    check(math.isclose(periods_per_year(idx, len(r)), 1.0, abs_tol=1e-9), f"{label}: ppy is 1")
    _, sortino, _, _, _ = compute_stats(r, idx)
    check(math.isclose(sortino, want, abs_tol=1e-6), f"{label}: sortino {sortino:.7f} == {want}")

# ---- losses all the same size: old formula returned 0.0 ---------------------------------
# r = [.02, -.01, -.01, -.01, .02]: mean = .01/5 = .002; dd = sqrt(3e-4/5) = .0077460
# sortino = .002/.0077460 = .2581989
r = [0.02, -0.01, -0.01, -0.01, 0.02]
# 5 bars: span 5×365.25 is not whole days — use a daily index and scale by sqrt(ppy)
idx = pd.date_range("2020-01-01", periods=len(r), freq="D")
sharpe, sortino, _, _, _ = compute_stats(r, idx)
ppy = periods_per_year(idx, len(r))
check(sortino > 0, f"equal-size losses: sortino {sortino:.4f} is not 0")
check(math.isclose(sortino, 0.2581989 * math.sqrt(ppy), rel_tol=1e-6),
      f"equal-size losses: sortino == .2581989 × sqrt(ppy) ({sortino:.4f})")
# annualisation is the same factor Sharpe uses: sortino/sharpe == std_r/dd, ppy cancels
std_r = np.std(r, ddof=1)
check(math.isclose(sortino / sharpe, std_r / 0.0077460, rel_tol=1e-5),
      "annualised with the same sqrt(ppy) as Sharpe")

# a single losing bar: old formula (needs ≥ 2 losses for a std) also returned 0.0
r = [0.01, 0.02, -0.01, 0.03]
_, sortino, _, _, _ = compute_stats(r, idx_ppy1(4))
# mean = .05/4 = .0125; dd = sqrt(1e-4/4) = .005 → 2.5
check(math.isclose(sortino, 2.5, abs_tol=1e-9), f"single losing bar: sortino {sortino:.4f} == 2.5")

# ---- no losing bar: same convention as Sharpe on zero volatility → 0.0, JSON-safe ----------
sharpe0, _, _, _, _ = compute_stats([0.01, 0.01, 0.01, 0.01], idx_ppy1(4))
check(sharpe0 == 0.0, "reference: Sharpe on zero volatility is 0.0")
_, sortino, omega, _, _ = compute_stats([0.01, 0.0, 0.02, 0.0], idx_ppy1(4))
check(sortino == 0.0 and isinstance(sortino, float), f"no losing bar: sortino is 0.0 like Sharpe ({sortino!r})")
check(json.dumps({"s": sortino}) == '{"s": 0.0}', "no losing bar: serialises as 0.0, not inf/nan")

# NaN bars are treated as 0 (unchanged behaviour) — they count as flat bars in the denominator
_, s_nan, _, _, _ = compute_stats([0.02, float("nan"), 0.03, -0.02], idx_ppy1(4))
_, s_zero, _, _, _ = compute_stats([0.02, 0.0, 0.03, -0.02], idx_ppy1(4))
check(s_nan == s_zero, "NaN bar == flat bar")

print(f"\n{'PASS' if fails == 0 else 'FAIL'} ({fails} failures)")
sys.exit(1 if fails else 0)
