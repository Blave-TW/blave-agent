"""Minimal check for lib/strategy.ladder_position — no network, no api.
Synthetic path: RSI-style trigger at 100, five rungs (−2/−5/−9.5/−16/−25% from the base fill,
each order 1.8× the last) all filled on the way down to 73, then a bounce that exits on the
first Close ≥ average cost × 1.03. Fills are next-bar Opens (Open = previous Close here), so
the oracle's average is plain arithmetic on the path. Also: a gap through two rungs adds both
on one bar, the exit bar does not re-enter while the trigger holds, invalid bars (Open=0,
Close=0, NaN Close with a valid Open) neither fill nor add, a misaligned entry raises.
Run: cd blave-agent && .venv/bin/python tests/check_ladder_position.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import numpy as np
import pandas as pd
from lib.strategy import ladder_position

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

DEVS, MULT, TP = [0.02, 0.05, 0.095, 0.16, 0.25], 1.8, 0.03
costs = [MULT ** k for k in range(6)]
total = sum(costs)
cum = [sum(costs[:k]) / total for k in range(7)]

def frame(closes):
    c = pd.Series(closes, dtype=float)
    return pd.DataFrame({"Open": c.shift(1).fillna(c.iloc[0]).to_numpy(), "Close": c.to_numpy()},
                        index=pd.date_range("2025-01-01", periods=len(c), freq="4h"))

down = [100, 100, 98, 95, 90.5, 84, 75, 73]          # one rung per bar, exactly on each level
fills = [100, 98, 95, 90.5, 84, 75]                  # each order's next-bar Open
avg = total / sum(c / p for c, p in zip(costs, fills))
tp_level = avg * (1 + TP)
up = [76, 78, 80, 82, round(tp_level - 0.01, 4), round(tp_level + 0.01, 4), 85, 86]
df = frame(down + up)
trig = pd.Series(False, index=df.index); trig.iloc[0] = True
w = ladder_position(trig, df, DEVS, mult=MULT, tp_pct=TP)
exit_bar = len(down) + 5
want = [cum[1], cum[1], cum[2], cum[3], cum[4], cum[5], cum[6], cum[6]] + [cum[6]] * 5 + [0.0, 0.0, 0.0]
check(np.allclose(w.to_numpy(), want), f"five rungs fill bar by bar, full ladder = 1.0, exit on bar {exit_bar}")
check(abs(w.iloc[6] - 1.0) < 1e-12, "full ladder weight is exactly 1.0")
check(w.iloc[exit_bar - 1] == 1.0 and w.iloc[exit_bar] == 0.0,
      f"exit on the first Close ≥ average × 1.03 (average {avg:.4f}, level {tp_level:.4f}), not one tick earlier")

# trigger still true on the exit bar: no re-entry that bar, re-entry on the next
trig2 = trig.copy(); trig2.iloc[exit_bar:] = True
w2 = ladder_position(trig2, df, DEVS, mult=MULT, tp_pct=TP)
check(w2.iloc[exit_bar] == 0.0 and abs(w2.iloc[exit_bar + 1] - cum[1]) < 1e-12,
      "exit bar does not re-check the trigger; a level trigger still true re-enters on the next bar")

# gap through rungs 1 and 2 in one bar; NaN Close holds
dfg = frame([100, 100, 94, np.nan, 94])
wg = ladder_position(pd.Series([True, False, False, False, False], index=dfg.index), dfg, DEVS, mult=MULT, tp_pct=TP)
check(np.allclose(wg.to_numpy(), [cum[1], cum[1], cum[3], cum[3], cum[3]]), "a gap through two rungs adds both on one bar; NaN Close holds")

# rungs measure from the base FILL (next Open 95), not the trigger bar's Close (100)
dfe = pd.DataFrame({"Open": [100.0, 95.0], "Close": [100.0, 92.0]}, index=pd.date_range("2025-01-01", periods=2, freq="4h"))
we = ladder_position(pd.Series([True, False], index=dfe.index), dfe, DEVS, mult=MULT, tp_pct=TP)
check(np.allclose(we.to_numpy(), [cum[1], cum[2]]), "rungs measure from the base fill: 92 is one rung below 95, two below 100")

# invalid bars (finite and > 0, as lib.exits.apply_exits): Open=0 falls back to the last valid Close
idx3 = pd.date_range("2025-01-01", periods=3, freq="4h")
d0 = pd.DataFrame({"Open": [100.0, 0.0, 99.0], "Close": [100.0, 100.0, 99.0]}, index=idx3)
w0 = ladder_position(pd.Series([True, False, False], index=idx3), d0, DEVS, mult=MULT, tp_pct=0.009)
check(np.allclose(w0.to_numpy(), [cum[1], cum[1], cum[1]]),
      "Open=0 on the fill bar: no ZeroDivisionError, fills at the last valid Close (100), so 99 is not +0.9% TP")
# Close=0: holds, adds no rung (every rung's `c <= level` would be true)
dz = frame([100, 100, 0, 100, 100])
wz = ladder_position(pd.Series([True] + [False] * 4, index=dz.index), dz, DEVS, mult=MULT, tp_pct=TP)
check(np.allclose(wz.to_numpy(), [cum[1]] * 5), "Close=0: the bar holds and adds no rung (not the whole ladder)")
# Close NaN with a valid Open: the pending order is not booked there, it fills at the next valid bar's Open
dn = pd.DataFrame({"Open": [100.0, 100.0, 90.0], "Close": [100.0, np.nan, 92.0]}, index=idx3)
wn = ladder_position(pd.Series([True, False, False], index=idx3), dn, DEVS, mult=MULT, tp_pct=TP)
check(np.allclose(wn.to_numpy(), [cum[1], cum[1], cum[1]]),
      "NaN Close, valid Open: no fill on that bar; base fills at the next valid Open (90), so 92 adds no rung")

try:
    ladder_position(pd.Series([True, False, False]), d0, DEVS, mult=MULT, tp_pct=TP); ok = False
except ValueError:
    ok = True
check(ok, "entry on a different index raises ValueError instead of returning all 0")

for bad in ([], [0.05, 0.02], [0.0, 0.1]):
    try:
        ladder_position(trig, df, bad, mult=MULT, tp_pct=TP); ok = False
    except ValueError:
        ok = True
    check(ok, f"devs={bad} raises ValueError")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
