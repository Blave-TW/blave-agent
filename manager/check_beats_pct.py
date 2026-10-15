"""Minimal check for the walk-forward's per-metric beats% —
`python3 manager/check_beats_pct.py`.

What goes silently wrong if this breaks: the max-drawdown beats% reads
backwards (a deeper drawdown counted as a win), or a tie counts as a win.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

from management_backtest import _beats_pct, _max_drawdown

# Higher-is-better metrics.
assert _beats_pct(1.5, np.array([1.0, 2.0, 1.4, 1.6])) == 50.0
assert _beats_pct(1.0, np.array([1.0, 1.0])) == 0.0          # tie is not a win
assert _beats_pct(1.0, np.array([])) == 0.0

# Max drawdown is a negative %: shallower = larger = better.
deep  = _max_drawdown(np.array([0.01, -0.20, 0.01]))
mild  = _max_drawdown(np.array([0.01, -0.05, 0.01]))
assert deep < mild < 0, (deep, mild)
assert _beats_pct(mild, np.array([deep, deep])) == 100.0
assert _beats_pct(deep, np.array([mild, mild])) == 0.0

print('check_beats_pct: ok')
