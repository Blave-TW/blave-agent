"""Minimal check for the proposal's port_returns — `python3 manager/check_port_returns.py`.

What goes silently wrong if this breaks: drawdown-based sizing reads days a
held member did not exist yet, or loses a held member's worst days to a
zero-weight one (drawdown too shallow, leverage too high), or the series no
longer matches the weights the proposal shows.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

# manager.py imports scipy at module level for the slope optimiser; nothing
# checked here touches it, so a dev venv without scipy can still run this.
try:
    import scipy.optimize  # noqa: F401
except ImportError:
    import types
    sys.modules['scipy'] = types.ModuleType('scipy')
    sys.modules['scipy.optimize'] = types.ModuleType('scipy.optimize')
    sys.modules['scipy.optimize'].minimize = None

from manager import build_returns, port_returns, VOL_WINDOW


def member(first, n, rets=None, skip=()):
    dates = [d for d in pd.date_range(first, periods=n) if str(d.date()) not in skip]
    rets = rets if rets is not None else [0.001 * ((i % 7) - 3) for i in range(len(dates))]
    return {'daily_dates': [str(d.date()) for d in dates], 'daily_returns': list(rets)}


def run(valid, weights):
    _, real = build_returns(valid)
    return port_returns(valid, real, np.array([weights[c] for c in real.columns]))


# Overlap + weights: `young` starts 20 days after `old`; both held.
old, young = member('2020-01-01', 150), member('2020-01-21', 140)
pr = run({'old': old, 'young': young}, {'old': 0.25, 'young': 0.75})
assert set(pr) == {'start', 'end', 'days', 'r'}, pr
assert (pr['start'], pr['end']) == ('2020-01-21', '2020-05-29'), pr
assert pr['days'] == len(pr['r']) == 130, pr['days']
expected = [round(0.25 * a + 0.75 * b, 6)
            for a, b in zip(old['daily_returns'][20:], young['daily_returns'][:130])]
assert pr['r'] == expected

# Order of members does not matter: weights follow ret_df's columns.
assert run({'young': young, 'old': old}, {'old': 0.25, 'young': 0.75}) == pr

# A zero-weight member must not set the span. `held` crashes on days 10-20;
# `idle` (weight 0) starts on day 50 — clipping on it would hide the crash.
crash = [-0.05 if 10 <= i < 20 else 0.001 for i in range(200)]
pr0 = run({'held': member('2020-01-01', 200, crash), 'idle': member('2020-02-20', 150)},
          {'held': 1.0, 'idle': 0.0})
assert pr0['start'] == '2020-01-01' and pr0['days'] == 200, pr0['start']
assert min(pr0['r']) == -0.05

# A day missing from every member inside the span is a calendar day of 0.
gap = ('2020-02-01',)
prg = run({'a': member('2020-01-01', 120, skip=gap), 'b': member('2020-01-01', 120, skip=gap)},
          {'a': 0.5, 'b': 0.5})
assert prg['days'] == 120 == len(prg['r']), prg['days']
assert prg['r'][31] == 0.0

# Too short to size on: null, not a near-zero drawdown.
short = run({'a': member('2020-01-01', 200), 'b': member('2020-06-01', 100)}, {'a': 0.5, 'b': 0.5})
assert short is None  # overlap 2020-06-01..07-18 = 48 days
edge = run({'a': member('2020-01-01', VOL_WINDOW)}, {'a': 1.0})
assert edge is not None and edge['days'] == VOL_WINDOW
assert run({'a': member('2020-01-01', VOL_WINDOW - 1)}, {'a': 1.0}) is None

# Disjoint held members: null.
assert run({'a': member('2020-01-01', 100), 'b': member('2021-01-01', 100)},
           {'a': 0.5, 'b': 0.5}) is None

# Non-finite input must not reach the JSON (the browser rejects NaN/Infinity).
bad = member('2020-01-01', 100)
bad['daily_returns'][50] = float('inf')
assert run({'a': bad}, {'a': 1.0}) is None

# Size: ~1400 days stays small on the wire.
rng = np.random.default_rng(0)
big = {k: member('2022-01-01', 1400, list(rng.normal(0, 0.02, 1400))) for k in 'ab'}
size = len(json.dumps(run(big, {'a': 0.5, 'b': 0.5})))
assert size < 20_000, size

print(f'ok (1400-day series = {size} bytes)')
