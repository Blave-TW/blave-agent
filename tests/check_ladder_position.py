"""Minimal check for lib/strategy.ladder_position — no network, no api.
Synthetic path: RSI-style trigger at 100, five rungs (−2/−5/−9.5/−16/−25% from the base fill,
each order 1.8× the last) all filled on the way down to 73, then a bounce that exits on the
first Close ≥ average cost × 1.03. Fills are next-bar Opens (Open = previous Close here), so
the oracle's average is plain arithmetic on the path. Also: a gap through two rungs adds both
on one bar, the exit bar does not re-enter while the trigger holds, invalid bars (Open=0,
Close=0, NaN Close with a valid Open) neither fill nor add — the runner's own valid mask —, a
contract roll (instrument_id change) resets the ladder instead of reading the spread as a dip
or a take-profit, a misaligned entry raises. ladder_sizing: what live sends at a thin amount
($1000 BTC at a ~$50 lot, TMF 10 and 3 lots) and the runner's backtest warning built from it.
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

# invalid bars = the runner's valid mask (Open AND Close finite and > 0): an Open=0 bar holds and
# books nothing, the order fills at the next valid Open (95), so 97 is +2.1% (no rung), not −3%
idx3 = pd.date_range("2025-01-01", periods=3, freq="4h")
d0 = pd.DataFrame({"Open": [100.0, 0.0, 95.0], "Close": [100.0, 100.0, 97.0]}, index=idx3)
w0 = ladder_position(pd.Series([True, False, False], index=idx3), d0, DEVS, mult=MULT, tp_pct=TP)
check(np.allclose(w0.to_numpy(), [cum[1], cum[1], cum[1]]),
      "Open=0 bar is skipped like the runner drops it: base fills at the next valid Open (95), 97 adds no rung")
# Close=0: holds, adds no rung (every rung's `c <= level` would be true)
dz = frame([100, 100, 0, 100, 100])
wz = ladder_position(pd.Series([True] + [False] * 4, index=dz.index), dz, DEVS, mult=MULT, tp_pct=TP)
check(np.allclose(wz.to_numpy(), [cum[1]] * 5), "Close=0: the bar holds and adds no rung (not the whole ladder)")
# Close NaN with a valid Open: the pending order is not booked there, it fills at the next valid bar's Open
dn = pd.DataFrame({"Open": [100.0, 100.0, 90.0], "Close": [100.0, np.nan, 92.0]}, index=idx3)
wn = ladder_position(pd.Series([True, False, False], index=idx3), dn, DEVS, mult=MULT, tp_pct=TP)
check(np.allclose(wn.to_numpy(), [cum[1], cum[1], cum[1]]),
      "NaN Close, valid Open: no fill on that bar; base fills at the next valid Open (90), so 92 adds no rung")

# contract roll: base fills at 100 on contract A, B trades at a constant spread, no move inside
# either contract. Without the reset −2.5% reads as rung 1 and +2.5% (< tp 3%) keeps holding.
def roll_frame(b_price):
    idx = pd.date_range("2026-01-01", periods=6, freq="1D")
    d = pd.DataFrame({"Open": [100.0] * 3 + [b_price] * 3, "Close": [100.0] * 3 + [b_price] * 3}, index=idx)
    d["instrument_id"] = ["A", "A", "A", "B", "B", "B"]
    return d

R_DEVS, R_MULT = [0.02, 0.05], 2.0
r_cum1 = 1 / sum(R_MULT ** k for k in range(3))
for b_price, what in ((97.5, "negative spread (97.5) is not a dip: no rung"),
                      (102.5, "positive spread (102.5) is not a gain: the cycle ends, no carried position")):
    dr = roll_frame(b_price)
    wr = ladder_position(pd.Series([True] + [False] * 5, index=dr.index), dr, R_DEVS, mult=R_MULT, tp_pct=0.03)
    check(np.allclose(wr.to_numpy(), [r_cum1] * 3 + [0.0] * 3), f"roll resets the ladder — {what}")
dr = roll_frame(97.5)
wr = ladder_position(pd.Series([True, False, False, False, True, False], index=dr.index), dr, R_DEVS,
                     mult=R_MULT, tp_pct=0.03)
check(np.allclose(wr.to_numpy(), [r_cum1] * 3 + [0.0, r_cum1, r_cum1]),
      "after a roll a new trigger enters at the new contract's price")
wn_id = ladder_position(pd.Series([True] + [False] * 5, index=dr.index), dr[["Open", "Close"]], R_DEVS,
                        mult=R_MULT, tp_pct=0.03)
check(wn_id.iloc[3] > r_cum1, "no instrument_id column: a continuous series sees the move as a move (unchanged)")
# TAIFEX: the series has no instrument_id, the roll is txf_settlement_mask's bar (the last
# bar of contract A) — passed as `settle` it is flat there and the ladder starts over
for b_price in (97.5, 102.5):
    dt = roll_frame(b_price)[["Open", "Close"]]
    settle = pd.Series([False, False, True, False, False, False], index=dt.index)
    wt = ladder_position(pd.Series([True] + [False] * 5, index=dt.index), dt, R_DEVS, mult=R_MULT,
                         tp_pct=0.03, settle=settle)
    check(np.allclose(wt.to_numpy(), [r_cum1, r_cum1, 0.0, 0.0, 0.0, 0.0]),
          f"settle bar ends the cycle: the {b_price} spread adds no rung and carries no position")
    wt = ladder_position(pd.Series([True, False, True, True, False, False], index=dt.index), dt, R_DEVS,
                         mult=R_MULT, tp_pct=0.03, settle=settle)
    check(wt.iloc[2] == 0.0 and abs(wt.iloc[3] - r_cum1) < 1e-12,
          "a trigger on the settle bar is ignored; the next contract's trigger enters")
check(w.attrs.get("ladder") == {"devs": DEVS, "mult": MULT, "rolls": False}, "attrs['ladder'] carries devs / mult / rolls")

# ── ladder_sizing ──
from lib.strategy import ladder_sizing
s1 = ladder_sizing(1000, DEVS, MULT, min_order=52.5)        # BTC perp lot ≈ $50, × 1.05 like the reconciler
check(abs(s1["orders"][0] - 1000 / total) < 1e-9 and s1["skipped"] == [0],
      f"$1000 BTC at a $52.5 minimum: base ${s1['orders'][0]:.2f} is not sent")
check(abs(s1["trades"][1] - 1000 * cum[2]) < 1e-9, "the skipped base merges into rung 1's order")
check(abs(s1["min_amount"] - 52.5 * total) < 1e-6 and not ladder_sizing(s1["min_amount"], DEVS, MULT, min_order=52.5)["skipped"],
      f"min amount {s1['min_amount']:.2f} = 52.5 × Σ, and at it every order trades")
check(not ladder_sizing(1000, DEVS, MULT, min_order=10)["skipped"], "$1000 at the flat $10 floor: every order trades")
t10 = ladder_sizing(10, DEVS, MULT, lots=True)
check(t10["targets"] == [0, 1, 1, 3, 5, 10] and t10["skipped"] == [0, 2],
      f"TMF 10 lots: targets {t10['targets']}, base and rung 2 send nothing")
t3 = ladder_sizing(3, DEVS, MULT, lots=True)
check(t3["targets"] == [0, 0, 0, 1, 2, 3] and t3["skipped"] == [0, 1, 2], f"TMF 3 lots: targets {t3['targets']}")
flat = ladder_sizing(6, DEVS, 1.0, lots=True)
check(flat["trades"] == [1] * 6 and flat["min_amount"] == 6, "mult=1, 5 rungs: 6 lots = 1 lot per order, the minimum")
check(ladder_sizing(1, DEVS, MULT, lots=True)["min_amount"] is not None, "geometric lots: a minimum exists")

# runner's backtest hint — portfolio and venue lookups stubbed, nothing on disk or network
import lib.portfolio as _pf, lib.execute as _ex
from lib.runner import _ladder_sizing_lines
_saved = (_pf.load_portfolio_config, _pf.strategy_amounts, _ex._venue_sizes_usd)
try:
    _pf.load_portfolio_config = lambda: {"amounts": {"lad": 1000.0}, "asset_specs": {}}
    _pf.strategy_amounts = lambda cfg=None: {"lad": 1000.0}
    _ex._venue_sizes_usd = lambda sym, floor: (52.5, 50.0)
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "BTCUSDT"})
    check(any("WARNING" in l and "[0]" in l and "rung 1" in l for l in lines), "runner warns: $1000 BTC base not sent")
    _pf.load_portfolio_config = lambda: {"amounts": {"lad": 3.0},
                                          "asset_specs": {"lad": {"type": "futures_contracts"}}}
    _pf.strategy_amounts = lambda cfg=None: {"lad": 3.0}
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "TMF"})
    check(any("WARNING" in l and "lots" in l and "rung 3" in l for l in lines), "runner warns: TMF 3 lots first order at rung 3")
    _pf.strategy_amounts = lambda cfg=None: {"lad": 6.0}
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": 1.0, "rolls": False}, {"STRATEGY_NAME": "lad", "SYMBOL": "TMF"})
    check(any("WARNING" in l and "settle=" in l for l in lines), "runner: TMF ladder without settle= is warned")
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": 1.0, "rolls": True}, {"STRATEGY_NAME": "lad", "SYMBOL": "TMF"})
    check(not any("WARNING" in l for l in lines), "runner: TMF 6 lots, mult=1, settle passed — no warning")
    _ex._venue_sizes_usd = lambda sym, floor: (_ for _ in ()).throw(RuntimeError("offline"))
    _pf.load_portfolio_config = lambda: {"amounts": {}, "asset_specs": {}}
    _pf.strategy_amounts = lambda cfg=None: {}
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "BTCUSDT"})
    check(len(lines) == 1 and "not looked up" in lines[0], "lookup failure: the flat floor, said so; no amount → no verdict")
finally:
    _pf.load_portfolio_config, _pf.strategy_amounts, _ex._venue_sizes_usd = _saved

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
