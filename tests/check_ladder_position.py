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
# settle on a bar the runner drops (Open=0): the reset still happens there
dv = roll_frame(97.5)[["Open", "Close"]]
dv.iloc[2, dv.columns.get_loc("Open")] = 0.0
settle = pd.Series([False, False, True, False, False, False], index=dv.index)
wv = ladder_position(pd.Series([True] + [False] * 5, index=dv.index), dv, R_DEVS, mult=R_MULT, tp_pct=0.03,
                     settle=settle)
check(np.allclose(wv.to_numpy()[3:], 0.0), "a settle bar the runner drops still ends the cycle (97.5 adds no rung)")
check(w.attrs.get("ladder") == {"devs": DEVS, "mult": MULT}, "attrs['ladder'] carries devs / mult")
from lib.exits import apply_exits
check(apply_exits(w, df, stop_pct=0.5).attrs.get("ladder") == w.attrs["ladder"],
      "apply_exits around the ladder keeps attrs['ladder'] (the runner's sizing line survives)")

# ── ladder_sizing ──
from lib.strategy import ladder_sizing
from lib.portfolio import compute_diff
s1 = ladder_sizing(1000, DEVS, MULT, min_order=52.5)        # BTC perp lot ≈ $50, × 1.05 like the reconciler
check(abs(s1["orders"][0] - 1000 / total) < 1e-9 and s1["skipped"] == [0],
      f"$1000 BTC at a $52.5 minimum: base ${s1['orders'][0]:.2f} is not sent")
check(abs(s1["trades"][1] - 1000 * cum[2]) < 1e-9, "the skipped base merges into rung 1's order")
check(52.5 * total * 1.001 <= s1["min_amount"] <= 52.5 * total * 1.01 and s1["min_amount"] == round(s1["min_amount"], 2),
      f"min amount {s1['min_amount']:.2f} sits ≥ 0.1% above 52.5 × Σ = {52.5 * total:.4f} (off the gate's edge), in cents")
check(not ladder_sizing(1000, DEVS, MULT, min_order=10)["skipped"], "$1000 at the flat $10 floor: every order trades")
t10 = ladder_sizing(10, DEVS, MULT, lots=True)
check(t10["targets"] == [0, 1, 1, 3, 5, 10] and t10["skipped"] == [0, 2],
      f"TMF 10 lots: targets {t10['targets']}, base and rung 2 send nothing")
t3 = ladder_sizing(3, DEVS, MULT, lots=True)
check(t3["targets"] == [0, 0, 0, 1, 2, 3] and t3["skipped"] == [0, 1, 2], f"TMF 3 lots: targets {t3['targets']}")
flat = ladder_sizing(6, DEVS, 1.0, lots=True)
check(flat["trades"] == [1] * 6 and flat["min_amount"] == 6, "mult=1, 5 rungs: 6 lots = 1 lot per order, the minimum")
check(ladder_sizing(1, DEVS, MULT, lots=True)["min_amount"] is not None, "geometric lots: a minimum exists")
DEV7 = [0.01 * k for k in range(1, 8)]
tie = ladder_sizing(4, DEV7, 1.0, lots=True)
check(tie["targets"] == [1, 1, 2, 2, 3, 3, 4, 4],
      f"half-up ties: 0.5 lot → 1, 1.5 → 2 (round() would give 0 and 2) — {tie['targets']}")

# notional with a coarse lot vs the real lib.portfolio.compute_diff + half-up lot rounding
# (lib.venue_wiring._entry_qty), every amount on a grid — the prediction must match each one
def real_trades(amount, devs, mult, gate, lot, floor=False):
    cs = [mult ** k for k in range(len(devs) + 1)]
    tot = sum(cs)
    held, sent = 0.0, []
    gaps = real_trades.gaps = []
    for k in range(len(cs)):
        row = {"side": "long", "size": amount * (sum(cs[:k + 1]) / tot), "exchange": "x", "asset_spec": None,
               "market": "swap", "contributors": [], "gated": False}
        hold = {"BTCUSDT": {"side": "long", "size": held}} if held else {}
        o = compute_diff({"BTCUSDT": row}, hold, gate)
        gaps.append(row["size"] - held)
        q = (math.floor(o[0]["signed_diff"] / lot + (1e-9 if floor else 0.5)) * lot
             if o and o[0]["signed_diff"] > 0 else 0.0)
        sent.append(q)
        held += q
    return sent

import math
mism = []
for m, dv_ in ((1.0, DEVS), (1.8, DEVS), (1.0, [0.01 * k for k in range(1, 11)])):
    for amount in range(200, 6000, 7):
        got = ladder_sizing(amount, dv_, m, min_order=52.5, lot=50.0)["trades"]
        want = real_trades(amount, dv_, m, 52.5, 50.0)
        if [bool(x) for x in got] != [bool(x) for x in want] or not np.allclose(got, want):
            mism.append((m, len(dv_), amount, got, want))
check(not mism, f"lot rounding: ladder_sizing matches compute_diff + half-up lots on every amount ({mism[:2]})")
mism = []
for m in (1.0, 1.8):   # paper TW stock: 2330 at 1,000, gate 1.05 shares, whole shares floored
    for amount in range(5000, 120000, 337):
        got = ladder_sizing(amount, DEVS, m, min_order=1050.0, lot=1000.0, lot_floor=True)["trades"]
        want = real_trades(amount, DEVS, m, 1050.0, 1000.0, floor=True)
        if not np.allclose(got, want):
            mism.append((m, amount, got, want))
check(not mism, f"lot_floor: ladder_sizing matches compute_diff + floored shares on every amount ({mism[:2]})")
lm = ladder_sizing(330, DEVS, 1.0, min_order=52.5, lot=50.0)
check(lm["trades"] == [50, 50, 50, 50, 100, 0], f"$330, mult=1, $50 lot: the last rung merges ({lm['trades']})")
mn = ladder_sizing(330, DEVS, 1.0, min_order=52.5, lot=50.0)["min_amount"]
check(all(real_trades(mn, DEVS, 1.0, 52.5, 50.0)) and all(real_trades(math.ceil(mn * 1.005 * 100) / 100, DEVS, 1.0, 52.5, 50.0)),
      f"min amount {mn} (lot 50): every order goes out through compute_diff, and 0.5% above too")
# nine rungs, mult=1: the first amount where every order trades (525.53) merges a rung again 0.5% above
D9 = [0.01 * k for k in range(1, 10)]
mn9 = ladder_sizing(1000, D9, 1.0, min_order=52.5, lot=50.0)["min_amount"]
check(all(real_trades(mn9, D9, 1.0, 52.5, 50.0)) and all(real_trades(math.ceil(mn9 * 1.005 * 100) / 100, D9, 1.0, 52.5, 50.0)),
      f"min amount {mn9} (9 rungs, lot 50) is not a lone working point: 0.5% above still trades every order")
# lot $0.06, ten rungs, mult=1: lot rounding squeezes the last gap onto the gate (110.2 → 9.99999…)
D10 = [0.015 * (k + 1) for k in range(10)]
mn10 = ladder_sizing(1, D10, 1.0, min_order=10, lot=0.06)["min_amount"]
real_trades(mn10, D10, 1.0, 10, 0.06)
check(min(real_trades.gaps) >= 10 * 1.001, f"min amount {mn10} (lot 0.06, 10 rungs): every gap ≥ 0.1% over the gate "
                                           f"(smallest {min(real_trades.gaps):.6f})")
check(ladder_sizing(0.6, [0.02], 1.0, min_order=0.05, lot=0.1, lot_floor=True)["trades"][0] > 0.29,
      "floored lots: 0.3 / 0.1 = 2.9999… is 3 lots, as lib.order_paper floors (q + 1e-9)")
mn0 = ladder_sizing(1000, DEVS, MULT, min_order=52.5)["min_amount"]
check(all(real_trades(mn0, DEVS, MULT, 52.5, 1e-9)), f"min amount {mn0} (no lot): every order goes out through compute_diff")

# runner's backtest hint — portfolio and venue lookups stubbed, nothing on disk or network
import tempfile
import lib.portfolio as _pf, lib.execute as _ex
from lib.runner import _ladder_sizing_lines
_saved = (_pf.load_portfolio_config, _pf.strategy_amounts, _ex._venue_sizes_usd)
def cfg(amounts, specs=None, exchanges=None):
    _pf.load_portfolio_config = lambda: {"amounts": amounts, "asset_specs": specs or {}, "exchanges": exchanges or {}}
    _pf.strategy_amounts = lambda c=None: dict(amounts)
cdf_file = os.path.join(tempfile.mkdtemp(prefix="ladcdf-"), "strategy.py")
open(cdf_file, "w").write('SYMBOL = "CDF"\ndef fetch_data(h):\n    from lib.data import fetch_twfutures_ohlcv\n'
                          '    return fetch_twfutures_ohlcv(SYMBOL, "1d", "2024-01-01", None, h)\n')
try:
    cfg({"lad": 1000.0})
    _ex._venue_sizes_usd = lambda sym, floor: (52.5, 50.0)
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "BTCUSDT"})
    check(any("WARNING" in l and "[0]" in l and "rung 1" in l for l in lines), "runner warns: $1000 BTC base not sent")
    check("one lot 50.00" in lines[0] and "merge" in lines[0], "a coarse lot is named, with the merge caveat")
    cfg({"lad": 330.0})
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": 1.0}, {"STRATEGY_NAME": "lad", "SYMBOL": "BTCUSDT"})
    check(any("WARNING" in l and "[5]" in l for l in lines),
          "runner passes the venue lot: $330, mult=1, $50 lot — rung 5 merges (no lot → no warning)")
    import lib.paper_data as _pd
    _had = hasattr(_pd, "is_tw_stock")
    _old_tw = getattr(_pd, "is_tw_stock", None)
    try:
        _pd.is_tw_stock = lambda sym: sym == "2330"
        _ex._venue_sizes_usd = lambda sym, floor: (1050.0, 1000.0)
        cfg({"lad": 5500.0}, exchanges={"lad": "paper"})
        lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "2330", "MARKET": "spot"})
        check(any("WARNING" in l and "[0, 1, 2] " in l for l in lines),
              "runner floors a TW stock's shares: 5,500 TWD skips [0, 1, 2] (half-up would say [0, 1, 2, 4])")
    finally:
        if _had:
            _pd.is_tw_stock = _old_tw
        else:
            del _pd.is_tw_stock
    _ex._venue_sizes_usd = lambda sym, floor: (52.5, 50.0)
    cfg({"lad": 3.0}, {"lad": {"type": "futures_contracts"}})
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "TMF"})
    check(any("WARNING" in l and "lots" in l and "rung 3" in l for l in lines), "runner warns: TMF 3 lots first order at rung 3")
    cfg({"lad": 3.0}, exchanges={"lad": "capital"})
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "CDF"})
    check(any("lots" in l and "rung 3" in l for l in lines), "CDF on a native-unit venue (no spec): lots via native_units")
    cfg({"lad": 3.0})
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "CDF", "__file__": cdf_file})
    check(any("lots" in l and "rung 3" in l for l in lines), "CDF with no venue saved: lots via the TAIFEX test")
    cfg({"lad": 3000.0}, exchanges={"lad": "binance"})
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "BTCUSDT"})
    check(not any(" lots" in l for l in lines), "a notional venue stays notional")
    cfg({"lad": 6.0}, {"lad": {"type": "futures_contracts"}})
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": 1.0}, {"STRATEGY_NAME": "lad", "SYMBOL": "TMF"})
    check(not any("WARNING" in l for l in lines), "runner: TMF 6 lots, mult=1 — no warning")
    _ex._venue_sizes_usd = lambda sym, floor: (_ for _ in ()).throw(RuntimeError("offline"))
    cfg({})
    lines = _ladder_sizing_lines({"devs": DEVS, "mult": MULT}, {"STRATEGY_NAME": "lad", "SYMBOL": "BTCUSDT"})
    check(len(lines) == 1 and "flat 10 floor" in lines[0] and "not looked up" in lines[0],
          "lookup failure: the reconciler's flat 10, said so; no amount → no verdict")
finally:
    _pf.load_portfolio_config, _pf.strategy_amounts, _ex._venue_sizes_usd = _saved

# one $10 gate: the reconciler, lib.execute and the runner read the same constant
import manager.reconciler as _rc
check(_rc.THRESHOLD == _ex.RECONCILE_THRESHOLD == _ex._RESIDUAL_USD, "THRESHOLD is lib.execute.RECONCILE_THRESHOLD")

# quality check: a ladder across a roll — the mask guard's TAIFEX test, plus stock-futures daily data
from lib.quality_check import ladder_roll_findings
def roll_findings(src):
    f = os.path.join(tempfile.mkdtemp(prefix="ladqc-"), "strategy.py")
    open(f, "w").write(src)
    return ladder_roll_findings(f)
LAD = "    return ladder_position(e, df, devs=[0.02], mult=1.0, tp_pct=0.03{extra})\n"
def src(head, extra=""):
    return head + "def compute_signals(df):\n    from lib.strategy import ladder_position\n    e = df['Close'] > 0\n" + LAD.format(extra=extra)
cases = [
    ('SYMBOL = "CDF"\ndef fetch_data(h):\n    return fetch_twfutures_ohlcv(SYMBOL, "1d", "a", None, h)\n', "", 1, "CDF via fetch_twfutures_ohlcv, no settle="),
    ('SYMBOL = "CDF"\ndef fetch_data(h):\n    return fetch_twfutures_ohlcv(SYMBOL, "1d", "a", None, h)\n', ", settle=txf_settlement_mask(df.index)", 0, "CDF with settle="),
    ('SYMBOL = "CDF"\ndef fetch_data(h):\n    return fetch_stock_futures_batch_daily(["CDF"], "a", None, h)\n', "", 1, "fetch_stock_futures_batch_daily, no settle="),
    ('SYMBOL = "TMF"\n', "", 1, "SYMBOL = TMF, no settle="),
    ('SYMBOL = "TMF"\n', "POS5", 1, "SYMBOL = TMF, five positional arguments, no settle"),
    ('SYMBOL = "TMF"\n', "POS6", 0, "SYMBOL = TMF, settle as the sixth positional argument"),
    ('SYMBOL = "BTCUSDT"\ndef fetch_data(h):\n    return fetch_kline(SYMBOL, "1h", "a", None, h)\n', "", 0, "crypto ladder"),
    ('SYMBOL = "CL"\ndef fetch_data(h):\n    return fetch_db_kline("NYMEX", SYMBOL, "ohlcv-1d", "a", None, h)\n', "", 1, "fetch_db_kline without settlement_signals_from_db"),
]
POS = {"POS5": "    return ladder_position(e, df, [0.02], 1.0, 0.03)\n",
       "POS6": "    return ladder_position(e, df, [0.02], 1.0, 0.03, txf_settlement_mask(df.index))\n"}
for head, extra, n, what in cases:
    code = src(head, extra) if extra not in POS else src(head).replace(LAD.format(extra=""), POS[extra])
    got = roll_findings(code)
    check(len(got) == n, f"ladder_roll: {what} → {n} warning(s) (got {len(got)})")
ok_db = src('SYMBOL = "CL"\ndef fetch_data(h):\n    return fetch_db_kline("NYMEX", SYMBOL, "ohlcv-1d", "a", None, h)\n'
            ).replace("    return ladder_position(", "    return settlement_signals_from_db(df, ladder_position(") + ")\n"
check(not roll_findings(ok_db), "fetch_db_kline + settlement_signals_from_db → no warning")

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
