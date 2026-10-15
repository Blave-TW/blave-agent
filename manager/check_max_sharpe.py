"""Minimal check for the `sharpe` built-in — `python3 manager/check_max_sharpe.py`.

What goes silently wrong if this breaks: the method hands weight to a losing
or merely volatile leg, fails to diversify between two good uncorrelated legs,
or chases a negative Sharpe instead of falling back to equal weight.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

from manager import sharpe_weights, BUILTIN_METHODS, _BUILTIN_FNS
from lib.allocator import BUILTIN_ALLOCATORS

rng = np.random.default_rng(7)
T = 400


def frame(**cols):
    return pd.DataFrame(cols, index=pd.date_range('2022-01-01', periods=T))


def ok(w, names):
    assert set(w) == set(names), w
    assert all(v >= 0 for v in w.values()), w
    assert abs(sum(w.values()) - 1) < 1e-3, w


def sharpe(r):
    return r.mean() / r.std()


# Two good uncorrelated legs with the same Sharpe split roughly evenly; a
# losing leg gets nothing. The mix must beat every single leg's Sharpe.
a, b = rng.normal(0.003, 0.01, T), rng.normal(0.003, 0.01, T)
loser = rng.normal(-0.003, 0.01, T)
df = frame(a=a, b=b, loser=loser)
w = sharpe_weights(df, 365)
ok(w, df.columns)
assert w['loser'] < 0.01, w
assert 0.25 < w['a'] < 0.75 and 0.25 < w['b'] < 0.75, w
mix = df.values[-365:] @ np.array([w[c] for c in df.columns])
assert sharpe(mix) >= max(sharpe(df[c].values[-365:]) for c in ('a', 'b')), w

# Same mean, much higher vol: the low-vol leg dominates (slope would too, but
# an equal-weight bug would not).
df = frame(calm=rng.normal(0.001, 0.005, T), wild=rng.normal(0.001, 0.04, T))
w = sharpe_weights(df, 365)
ok(w, df.columns)
assert w['calm'] > 0.9, w

# Nothing made money over the window: equal weight, not "least bad".
df = frame(x=rng.normal(-0.001, 0.01, T), y=rng.normal(-0.002, 0.02, T))
assert sharpe_weights(df, 365) == {'x': 1.0, 'y': 1.0}

# Singular covariance: an exact duplicate and a leg that never moved.
dup = rng.normal(0.001, 0.01, T)
df = frame(p=dup, q=dup.copy(), flat=np.zeros(T))
w = sharpe_weights(df, 365)
ok(w, df.columns)
assert abs(w['p'] - w['q']) < 0.01 and w['flat'] < 0.01, w

# Only the last `lookback` rows count: manager.py passes the whole history.
early_bad = np.r_[np.full(T - 100, -0.01), rng.normal(0.004, 0.002, 100)]
df = frame(late=early_bad, steady=rng.normal(0.001, 0.002, T))
assert sharpe_weights(df, 100)['late'] > 0.5 and sharpe_weights(df, T)['late'] < 0.01, 'lookback ignored'

# Too little data → equal.
assert sharpe_weights(frame(a=a, b=b).iloc[:5], 365) == {'a': 1.0, 'b': 1.0}

# Wiring: picker literal, dispatch table and the reserved-name guard agree.
assert BUILTIN_METHODS['sharpe']['params'] == {'lookback': 365}
assert _BUILTIN_FNS['sharpe'] is sharpe_weights
assert set(BUILTIN_ALLOCATORS) == set(BUILTIN_METHODS) == set(_BUILTIN_FNS)

print('check_max_sharpe: ok')
