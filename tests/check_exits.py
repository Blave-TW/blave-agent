"""lib/exits.py — apply_exits (stop / take-profit / trailing / time stop, price-distance versions,
breakeven, cooldown, per-side values) and clamp_spot. No network.

  1. a case table run against lib.exits.apply_exits; 1c: old arguments give what the previous lib
     gave, bar for bar; 1d–1h: the 2026-10-11 arguments;
  2. the loop the agent hand-wrote on 2026-09-23 (0 of 8,770 bars changed) must fail the table;
  3. clamp_spot, and lib/runner.py really applying it: a spot strategy that emits shorts backtests
     exactly like its long-only twin, a swap one does not (real run() in a temp workspace).
Run: cd blave-agent && .venv/bin/python tests/check_exits.py
"""
import json, os, shutil, subprocess, sys, tempfile
import numpy as np, pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib.exits import apply_exits, clamp_spot

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

nan = np.nan
F5 = [100.0] * 5
# (label, kwargs, signal, Open, Close, instrument_id or None, expected position)
CASES = [
    ("stop long: -4% exits, flat until the base leaves and re-takes long", dict(stop_pct=0.03),
     [1, nan, nan, nan, nan, nan, 0, nan, 1, nan, nan], [100, 100, 99, 97, 96, 95, 96, 97, 98, 99, 100],
     [100, 99, 97.5, 96, 95, 96, 97, 98, 99, 100, 101], None, [1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1]),
    ("stop: a state-style base that stays long does not re-enter", dict(stop_pct=0.03),
     [1] * 6, [100] * 6, [100, 96, 96, 101, 102, 103], None, [1, 0, 0, 0, 0, 0]),
    ("stop short: +4% exits (side sign)", dict(stop_pct=0.03),
     [-1, nan, nan, nan, nan], [100, 100, 101, 104, 105], [100, 101, 104, 105, 106], None, [-1, -1, 0, 0, 0]),
    ("stop: no hit → identical to the ffilled base", dict(stop_pct=0.03),
     [1, nan, nan, 0, nan], [1] * 5, [1] * 5, None, [1, 1, 1, 0, 0]),
    ("stop: size changes on the same side do not lift it", dict(stop_pct=0.03),
     [0.5, 0.7, 0.6, 0.8, 0.9], F5, [100, 96, 97, 98, 99], None, [0.5, 0, 0, 0, 0]),
    ("stop: NaN fill Open → entry is the last valid Close, stop still fires", dict(stop_pct=0.03),
     [1, nan, nan, nan, nan], [100, nan, 99, 97, 96], [100, 99, 97.5, 96, 95], None, [1, 1, 1, 0, 0]),
    ("stop: NaN Close mid-trade changes nothing", dict(stop_pct=0.03),
     [1, nan, nan, nan, nan], F5, [100, 99, nan, 96, 95], None, [1, 1, 1, 0, 0]),
    ("stop: a 0 bar is skipped, not a -100% move", dict(stop_pct=0.03),
     [1, nan, nan, nan, nan], [100, 100, 0, 100, 100], [100, 100, 0, 100, 100], None, [1, 1, 1, 1, 1]),
    ("stop: a 0 bar where the fill would be → the next valid Open", dict(stop_pct=0.03),
     [1, nan, nan, nan, nan], [100, 0, 100, 99, 96], [100, 0, 100, 98, 96], None, [1, 1, 1, 1, 0]),
    ("stop: backwardation roll (100 → 90) is not a -11% loss", dict(stop_pct=0.03),
     [1, nan, nan, nan], [100, 100, 90, 90], [100, 99, 89, 88.5], ["A", "A", "B", "B"], [1, 1, 1, 1]),
    ("stop: contango roll (100 → 110) does not hide a loss", dict(stop_pct=0.03),
     [1, nan, nan, nan, nan], [100, 100, 110, 110, 110], [100, 99, 108, 107.8, 106], ["A", "A", "B", "B", "B"],
     [1, 1, 1, 1, 0]),
    ("take-profit long: +6% ≥ 5% exits and stays flat", dict(tp_pct=0.05),
     [1, nan, nan, nan, nan], F5, [100, 102, 106, 104, 103], None, [1, 1, 0, 0, 0]),
    ("take-profit short: a 6% fall exits", dict(tp_pct=0.05),
     [-1, nan, nan, nan, nan], F5, [100, 97, 94, 96, 97], None, [-1, -1, 0, 0, 0]),
    ("stop + TP set: only the one that is hit fires (a rise does not stop)", dict(stop_pct=0.03, tp_pct=0.2),
     [1, nan, nan, nan, nan], F5, [100, 104, 108, 110, 112], None, [1, 1, 1, 1, 1]),
    ("trailing long: up 10% then 4% off the best close exits", dict(trail_pct=0.03),
     [1, nan, nan, nan, nan, nan], [100] * 6, [100, 105, 110, 108, 105.6, 107], None, [1, 1, 1, 1, 0, 0]),
    ("trailing short: down 10% then 4% up from the best exits", dict(trail_pct=0.03),
     [-1, nan, nan, nan, nan], F5, [100, 95, 90, 92, 93.6], None, [-1, -1, -1, -1, 0]),
    ("trailing: a backwardation roll during the trail does not fire", dict(trail_pct=0.03),
     [1, nan, nan, nan, nan], [100, 100, 100, 90, 90], [100, 105, 110, 99.5, 99.2], ["A", "A", "A", "B", "B"],
     [1, 1, 1, 1, 1]),
    ("time stop: max_bars=3 holds three bars, then flat until the base re-takes the side", dict(max_bars=3),
     [1] * 5 + [0, 1, nan, nan, nan], [100] * 10, [100] * 10, None, [1, 1, 1, 0, 0, 0, 1, 1, 1, 0]),
    ("time stop: a dropped (NaN Close) bar is not counted", dict(max_bars=3),
     [1, nan, nan, nan, nan, nan], [100] * 6, [100, 100, nan, 100, 100, 100], None, [1, 1, 1, 1, 0, 0]),
    ("flip long → short after a stop: the short enters on its own", dict(stop_pct=0.03),
     [1, nan, nan, -1, nan], F5, [100, 96, 97, 97, 97], None, [1, 0, 0, -1, -1]),
]


def run_case(fn, kw, sig, opn, close, inst):
    df = pd.DataFrame({"Open": opn, "Close": close})
    if inst is not None:
        df["instrument_id"] = inst
    return [float(x) for x in fn(pd.Series(sig, dtype=float), df, **kw).tolist()]


def failures(fn):
    bad = []
    for label, kw, sig, opn, close, inst, want in CASES:
        try:
            got = run_case(fn, kw, sig, opn, close, inst)
        except Exception as e:
            got = repr(e)
        if got != [float(x) for x in want]:
            bad.append((label, got))
    return bad


# ── 1. the lib
bad = failures(apply_exits)
for label, *_ in CASES:
    hit = [g for l, g in bad if l == label]
    check(not hit, label + (f" (got {hit[0]})" if hit else ""))

for kw in ({}, {"stop_pct": 0}, {"stop_pct": -0.03}, {"tp_pct": 3}, {"max_bars": 0}, {"max_bars": 2.5}):
    try:
        apply_exits(pd.Series([1.0]), pd.DataFrame({"Open": [1.0], "Close": [1.0]}), **kw)
        ok = kw == {"tp_pct": 3}      # 300% is a legal (if odd) take-profit
    except ValueError:
        ok = kw != {"tp_pct": 3}
    check(ok, f"argument validation: {kw}")


# ── 1b. trigger="intrabar": touches on High / Low, exit still at the next Open,
#        attrs["exits"] records where a real order would have filled
def ib(sig, o, h, l, c, inst=None, **kw):
    df = pd.DataFrame({"Open": o, "High": h, "Low": l, "Close": c})
    if inst is not None:
        df["instrument_id"] = inst
    r = apply_exits(pd.Series(sig, dtype=float), df, trigger="intrabar", **kw)
    return ([float(x) for x in r.tolist()],
            [(e["reason"], None if pd.isna(e["order_price"]) else round(e["order_price"], 6))
             for e in r.attrs["exits"].to_dict("records")])

L5 = [1, nan, nan, nan, nan]
S5 = [-1, nan, nan, nan, nan]
# fill = Open[1] = 100 → stop level 97, TP level 106
got = ib(L5, F5, [100, 101, 101, 101, 101], [100, 99, 96.5, 99, 99], [100, 100, 99.5, 100, 100], stop_pct=0.03)
check(got == ([1, 1, 0, 0, 0], [("stop", 97.0)]),
      f"intrabar long stop: Low 96.5 touches 97 though the close is -0.5% → exit, order at 97 ({got})")
got = apply_exits(pd.Series(L5, dtype=float), pd.DataFrame({"Open": F5, "High": [100, 101, 101, 101, 101],
      "Low": [100, 99, 96.5, 99, 99], "Close": [100, 100, 99.5, 100, 100]}), stop_pct=0.03).tolist()
check(got == [1, 1, 1, 1, 1], f"…the same bars with trigger=\"close\" do not exit ({got})")
got = ib(S5, F5, [100, 101, 103.5, 101, 101], [100, 99, 99, 99, 99], [100, 100, 100.5, 100, 100], stop_pct=0.03)
check(got == ([-1, -1, 0, 0, 0], [("stop", 103.0)]), f"intrabar short stop: High 103.5 touches 103 → exit ({got})")
got = ib(L5, F5, [100, 101, 106.5, 101, 101], [100, 99, 99, 99, 99], [100, 100, 101, 100, 100], tp_pct=0.06)
check(got == ([1, 1, 0, 0, 0], [("tp", 106.0)]), f"intrabar long take-profit: High 106.5 touches 106 ({got})")
got = ib(S5, F5, [100, 101, 101, 101, 101], [100, 99, 93.5, 99, 99], [100, 100, 99, 100, 100], tp_pct=0.06)
check(got == ([-1, -1, 0, 0, 0], [("tp", 94.0)]), f"intrabar short take-profit: Low 93.5 touches 94 ({got})")
got = ib(L5, [100, 100, 95, 95, 95], [100, 101, 96, 96, 96], [100, 99, 94, 94, 94], [100, 100, 95, 95, 95], stop_pct=0.03)
check(got == ([1, 1, 0, 0, 0], [("stop", 95.0)]), f"gap through the stop: order at the Open 95, not the level 97 ({got})")
got = ib(S5, [100, 100, 105, 105, 105], [100, 101, 106, 106, 106], [100, 99, 104, 104, 104], [100, 100, 105, 105, 105], stop_pct=0.03)
check(got == ([-1, -1, 0, 0, 0], [("stop", 105.0)]), f"short gap through the stop: order at the Open 105, not 103 ({got})")
got = ib(L5, F5, [100, 101, 101, 101, 101], [100, 96, 99, 99, 99], [100, 100, 100, 100, 100], stop_pct=0.03)
check(got == ([1, 0, 0, 0, 0], [("stop", 97.0)]), f"intrabar: the fill bar's own Low counts (the entry was at its Open) ({got})")
got = ib(L5, [100, 100, 108, 100, 100], [100, 101, 109, 101, 101], [100, 99, 94, 99, 99], [100, 100, 100, 100, 100],
         stop_pct=0.03, tp_pct=0.06)
check(got == ([1, 1, 0, 0, 0], [("tp", 108.0)]), f"opened beyond the TP (108): TP fired first at the Open, even though Low also hit the stop ({got})")
got = ib(L5, F5, [100, 101, 107, 101, 101], [100, 99, 96, 99, 99], [100, 100, 100, 100, 100], stop_pct=0.03, tp_pct=0.06)
check(got == ([1, 1, 0, 0, 0], [("stop", 97.0)]), f"both levels touched, opened inside: the stop is assumed first ({got})")
got = ib([1] * 6, [100] * 6, [100, 101, 101, 101, 101, 101], [100, 96, 99, 99, 99, 99], [100] * 6, stop_pct=0.03)
check(got[0] == [1, 0, 0, 0, 0, 0], f"intrabar: a state-style base that stays long does not re-enter ({got[0]})")
got = ib(L5, F5, [100, 101, nan, 101, 101], [100, 99, 0, 99, 99], [100, 100, 100, 100, 100], stop_pct=0.03)
check(got == ([1, 1, 1, 1, 1], []), f"intrabar: a NaN / 0 High / Low falls back to the Close — no false stop ({got})")
got = ib([1, nan, nan, nan], [100, 100, 90, 90], [100, 101, 91, 90.5], [100, 99, 89, 88.5], [100, 99.5, 89.5, 89],
         inst=["A", "A", "B", "B"], stop_pct=0.03)
check(got[0] == [1, 1, 1, 1], f"intrabar: a backwardation roll (100 → 90) is not a stop ({got})")
got = ib([1, nan, nan, nan, nan, nan], [100, 100, 104, 109, 107, 107], [100, 105, 110, 110, 108, 108], [100, 100, 104, 106.5, 106, 106],
         [100, 104, 109, 108, 107, 107], trail_pct=0.03)
check(got == ([1, 1, 1, 0, 0, 0], [("trail", 106.7)]),
      f"intrabar trailing: best High 110, next Low 106.5 gives back 3.2% → order at 106.7 ({got})")
got = ib([1, nan, nan, nan, nan], [100, 100, 104, 103, 103], [100, 105, 110, 104, 104], [100, 100, 104, 102, 102],
         [100, 104, 109, 103, 103], trail_pct=0.03)
check(got == ([1, 1, 1, 0, 0], [("trail", 103.0)]), f"intrabar trailing, gap: best 110, opens 103 below the 106.7 trail → order at 103 ({got})")
try:
    apply_exits(pd.Series([1.0]), pd.DataFrame({"Open": [1.0], "Close": [1.0]}), stop_pct=0.03, trigger="intrabar")
    check(False, 'trigger="intrabar" without High/Low raises')
except ValueError:
    check(True, 'trigger="intrabar" without High/Low raises')


# ── 1c. old arguments only → bar-for-bar what the lib returned before the 2026-10-11 additions.
#        _legacy is that function, verbatim (docstring dropped); it is never edited.
def _legacy(signal, df, stop_pct=None, tp_pct=None, trail_pct=None, max_bars=None, trigger="close"):
    for name, v in (("stop_pct", stop_pct), ("tp_pct", tp_pct), ("trail_pct", trail_pct)):
        if v is not None and not (isinstance(v, (int, float)) and 0 < v < 10):
            raise ValueError(f"{name} must be a positive fraction (0.03 = 3%), got {v!r}")
    if max_bars is not None and not (isinstance(max_bars, (int, np.integer)) and max_bars >= 1):
        raise ValueError(f"max_bars must be a whole number of bars >= 1, got {max_bars!r}")
    if stop_pct is None and tp_pct is None and trail_pct is None and max_bars is None:
        raise ValueError("apply_exits needs at least one of stop_pct / tp_pct / trail_pct / max_bars")
    if trigger not in ("close", "intrabar"):
        raise ValueError(f'trigger must be "close" or "intrabar", got {trigger!r}')
    intrabar = trigger == "intrabar"
    if intrabar and not {'High', 'Low'} <= set(df.columns):
        raise ValueError('trigger="intrabar" needs High and Low columns in df')

    base = pd.Series(signal, dtype=float).ffill().fillna(0.0).to_numpy()
    opn = df['Open'].to_numpy(dtype=float)
    close = df['Close'].to_numpy(dtype=float)
    high = df['High'].to_numpy(dtype=float) if intrabar else close
    low = df['Low'].to_numpy(dtype=float) if intrabar else close
    inst = df['instrument_id'].to_numpy() if 'instrument_id' in df.columns else None
    index = getattr(signal, 'index', df.index)
    if not (len(base) == len(opn)):
        raise ValueError(f"signal has {len(base)} bars, df has {len(opn)}")

    def ok(x):
        return np.isfinite(x) and x > 0

    out = np.zeros(len(base))
    exits = []
    held, stopped, pending, last = 0.0, False, False, None
    entry = acc = best = np.nan
    bars = 0
    for t in range(len(base)):
        if not ok(close[t]):
            out[t] = held
            continue
        fill = opn[t] if ok(opn[t]) else close[last if last is not None else t]
        side = np.sign(held)
        if pending:
            entry, acc, best, bars, pending = fill, 1.0, 1.0, 0, False
        elif side and inst is not None and inst[t] != inst[last]:
            acc, entry = acc * close[last] / entry, fill
        if side and not stopped:
            k = acc / entry                         # price → trade ratio since the fill, roll-adjusted
            hi = high[t] if ok(high[t]) else close[t]
            lo = low[t] if ok(low[t]) else close[t]
            adverse, favour = (lo, hi) if side > 0 else (hi, lo)
            bars += 1

            def hit_at(pct):                        # price of a level `pct` from the fill (+ = favourable)
                return (1 + pct * side) / k

            def beyond(price, pct):                 # price at or past that level
                return ((price * k - 1) * side - pct) * np.sign(pct) >= 0

            reason = level = None
            o = fill if bars == 1 else (opn[t] if ok(opn[t]) else close[t])   # a gap fills here
            if intrabar:
                if stop_pct is not None and beyond(o, -stop_pct):
                    reason, level = "stop", o
                elif tp_pct is not None and beyond(o, tp_pct):
                    reason, level = "tp", o
            if reason is None and stop_pct is not None and beyond(adverse, -stop_pct):
                reason, level = "stop", hit_at(-stop_pct)
            if reason is None and trail_pct is not None:
                ref = adverse if intrabar else close[t]
                b = best if intrabar else (max(best, close[t] * k) if side > 0 else min(best, close[t] * k))
                if (ref * k / b - 1) * side <= -trail_pct:
                    reason, level = "trail", b * (1 - trail_pct * side) / k
                    if (o - level) * side < 0:
                        level = o
            if reason is None and max_bars is not None and bars >= max_bars:
                reason, level = "time", None
            if reason is None and tp_pct is not None and beyond(favour, tp_pct):
                reason, level = "tp", hit_at(tp_pct)
            best = max(best, favour * k) if side > 0 else min(best, favour * k)
            if reason is not None:
                stopped = True
                exits.append({"time": index[t], "reason": reason,
                              "order_price": float(level) if (intrabar and level is not None) else None})
        if stopped and np.sign(base[t]) != np.sign(base[last]):
            stopped = False
        want = 0.0 if stopped else base[t]
        if np.sign(want) != side:
            pending = bool(want)
        out[t], held, last = want, want, t
    res = pd.Series(out, index=index)
    # a DataFrame, not a list: pandas deep-copies attrs on every operation on the Series
    res.attrs["exits"] = pd.DataFrame(exits, columns=["time", "reason", "order_price"])
    return res


def _rand_world(seed):
    r = np.random.default_rng(seed)
    n = int(r.integers(5, 120))
    c = 100 * np.exp(np.cumsum(r.normal(0, r.choice([0.005, 0.02, 0.05]), n)))
    o = np.r_[c[0], c[:-1]] * (1 + r.normal(0, 0.004, n))
    h = np.maximum(o, c) * (1 + np.abs(r.normal(0, 0.01, n)))
    l = np.minimum(o, c) * (1 - np.abs(r.normal(0, 0.01, n)))
    for arr in (o, h, l, c):                       # bars the runner drops, and broken High / Low
        m = r.random(n) < 0.04
        arr[m] = r.choice([nan, 0.0], m.sum())
    sig = pd.Series(r.choice([1.0, -1.0, 0.0, nan, 0.5, -0.7], n, p=[.15, .12, .1, .55, .04, .04]))
    df = pd.DataFrame({"Open": o, "High": h, "Low": l, "Close": c})
    if r.random() < 0.4:
        df["instrument_id"] = np.cumsum(r.random(n) < 0.08)
    kw = {}
    if r.random() < .6: kw["stop_pct"] = float(r.choice([0.01, 0.03, 0.08]))
    if r.random() < .5: kw["tp_pct"] = float(r.choice([0.02, 0.05, 0.15]))
    if r.random() < .4: kw["trail_pct"] = float(r.choice([0.02, 0.05]))
    if r.random() < .3: kw["max_bars"] = int(r.integers(1, 12))
    if not kw: kw["stop_pct"] = 0.03
    kw["trigger"] = str(r.choice(["close", "intrabar"]))
    return sig, df, kw


diff, n_exits, reasons = [], 0, set()
for seed in range(400):
    sig, df, kw = _rand_world(seed)
    a, b = _legacy(sig, df, **kw), apply_exits(sig, df, **kw)
    n_exits += len(a.attrs["exits"])
    reasons |= set(a.attrs["exits"]["reason"])
    if a.tolist() != b.tolist() or repr(a.attrs["exits"].to_dict("records")) != repr(b.attrs["exits"].to_dict("records")):
        diff.append(seed)
check(not diff and n_exits > 1000 and reasons == {"stop", "tp", "trail", "time"},
      f"old arguments: positions and attrs['exits'] identical to the previous lib on 400 random series "
      f"({n_exits} exits, reasons {sorted(reasons)}; differing seeds {diff[:5]})")
r0 = apply_exits(pd.Series(L5, dtype=float), pd.DataFrame({"Open": F5, "Close": F5}), stop_pct=0.03)
check(list(r0.attrs["exits"].columns) == ["time", "reason", "order_price"] and r0.attrs["exits_unarmed"].empty,
      "attrs['exits'] keeps its three columns; attrs['exits_unarmed'] is there and empty")


# ── 1d. distances in price units (stop_dist / tp_dist / trail_dist): the strategy passes the
#        Series (2 * ATR, Close − prior low); the lib never computes an indicator
import warnings

def dz(sig, o, h, l, c, inst=None, trigger="intrabar", **kw):
    df = pd.DataFrame({"Open": o, "High": h, "Low": l, "Close": c}, dtype=float)
    if inst is not None:
        df["instrument_id"] = inst
    kw = {k: (pd.Series(v, index=df.index, dtype=float) if isinstance(v, list) else
              tuple(pd.Series(x, index=df.index, dtype=float) if isinstance(x, list) else x for x in v)
              if isinstance(v, tuple) else v) for k, v in kw.items()}
    import lib.exits
    lib.exits._unarmed_warned.clear()            # the lib warns once per process and exit
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        r = apply_exits(pd.Series(sig, dtype=float), df, trigger=trigger, **kw)
    return ([float(x) for x in r.tolist()],
            [(e["reason"], None if pd.isna(e["order_price"]) else round(e["order_price"], 6))
             for e in r.attrs["exits"].to_dict("records")],
            [(int(u["time"]), u["exit"]) for u in r.attrs["exits_unarmed"].to_dict("records")],
            [str(x.message) for x in w if issubclass(x.category, RuntimeWarning)])

H5 = [100, 101, 101, 101, 101]
C5 = [100, 100, 99, 100, 100]
# the signal is on bar 0, the fill is bar 1's Open (100). Distance 2 on the signal bar → stop 98.
got = dz(L5, F5, H5, [100, 99, 97.5, 99, 99], C5, stop_dist=[2, 9, 9, 9, 9])
check(got[:2] == ([1, 1, 0, 0, 0], [("stop", 98.0)]),
      f"stop_dist is read on the SIGNAL bar (2 → 98), not on the fill bar (9 → 91 would never be touched) ({got})")
got = dz(L5, F5, H5, [100, 99, 97.5, 99, 99], C5, stop_dist=[2, 2, 50, 50, 50])
check(got[:2] == ([1, 1, 0, 0, 0], [("stop", 98.0)]), f"the distance widening after the entry does not move the stop ({got})")
got = dz(L5, F5, H5, [100, 99, 99, 99, 99], C5, stop_dist=[2, 0.1, 0.1, 0.1, 0.1])
check(got[:2] == ([1, 1, 1, 1, 1], []), f"…nor does it narrowing: Low 99 never reaches 98 ({got})")
got = dz(S5, F5, [100, 101, 103.5, 101, 101], [100, 99, 99, 99, 99], C5, stop_dist=[3, 9, 9, 9, 9])
check(got[:2] == ([-1, -1, 0, 0, 0], [("stop", 103.0)]), f"short stop_dist 3 → 103, High 103.5 touches it ({got})")
got = dz(S5, F5, H5, [100, 99, 93.5, 99, 99], C5, tp_dist=[6, 1, 1, 1, 1])
check(got[:2] == ([-1, -1, 0, 0, 0], [("tp", 94.0)]),
      f"short tp_dist 6 → 94 (the fill bar's 1 → 99 would have exited a bar earlier) ({got})")
got = dz(L5, [100, 100, 95, 95, 95], [100, 101, 96, 96, 96], [100, 99, 94, 94, 94], [100, 100, 95, 95, 95], stop_dist=[3] * 5)
check(got[:2] == ([1, 1, 0, 0, 0], [("stop", 95.0)]), f"stop_dist, gap through the level: order at the Open 95, not 97 ({got})")
got = dz(L5, F5, H5, [100, 99, 97.5, 99, 99], [100, 100, 97.5, 100, 100], trigger="close", stop_dist=[2, 9, 9, 9, 9])
check(got[:2] == ([1, 1, 0, 0, 0], [("stop", None)]), f"stop_dist with trigger=\"close\": the close 97.5 is past 98 ({got})")
for kw_d, kw_p in ((dict(stop_dist=3), dict(stop_pct=0.03)), (dict(tp_dist=6.0), dict(tp_pct=0.06))):
    a = dz(L5, [100, 100, 95, 108, 95], [100, 101, 96, 109, 96], [100, 99, 94, 94, 94], [100, 100, 95, 100, 95], **kw_d)
    b = dz(L5, [100, 100, 95, 108, 95], [100, 101, 96, 109, 96], [100, 99, 94, 94, 94], [100, 100, 95, 100, 95], **kw_p)
    check(a == b and a[1], f"one number is a constant distance: {kw_d} on a fill of 100 ≡ {kw_p} ({a[1]})")
# a roll inside the trade: the distance became 3% of the fill, so it re-bases like stop_pct
got = dz([1, nan, nan, nan, nan], [100, 100, 90, 90, 90], [100, 100, 90, 90, 90], [100, 98.5, 88.5, 88, 86],
         [100, 99, 89, 88.5, 86], inst=["A", "A", "B", "B", "B"], stop_dist=[3, 30, 30, 30, 30])
check(got[:2] == ([1, 1, 1, 0, 0], [("stop", 88.181818)]),
      f"stop_dist across a backwardation roll (100 → 90): not stopped by the roll, stopped at -3% of the trade = 88.18 ({got})")
# chandelier: bar t is tested with the distance on the bar before it
TR = dict(o=[100, 100, 104, 108, 108], h=[100, 105, 110, 110, 110], l=[100, 100, 104, 106, 107.5], c=[100, 104, 109, 108, 108])
got = dz(L5, **TR, trail_dist=[5, nan, 5, 2, 2])
check(got[:2] == ([1, 1, 1, 1, 0], [("trail", 108.0)]),
      f"trail_dist moves bar by bar: best 110, distance 5 → 105 holds bar 3 (Low 106); 2 → 108 exits bar 4. "
      f"Reading bar 3's own value would exit a bar early ({got})")
got = dz(L5, **TR, trail_dist=[5] * 5)
check(got[:2] == ([1, 1, 1, 1, 1], []), f"…a constant 5 never fires on those bars ({got})")
got = dz([-1, nan, nan, nan, nan], [100, 100, 96, 92, 92], [100, 100, 96, 94, 92.6], [100, 95, 90, 90, 90], [100, 96, 91, 92, 92],
         trail_dist=[5, 5, 5, 2, 2])
check(got[:2] == ([-1, -1, -1, -1, 0], [("trail", 92.0)]), f"short trail_dist: best 90, distance 2 → 92, High 92.6 ({got})")
# a distance that cannot arm: that exit is off for the trade, said out loud, the others still run
for d0, why in ((nan, "NaN"), (0.0, "0"), (-1.0, "negative"), (100.0, "the whole fill price")):
    got = dz(L5, F5, [100, 101, 101, 109, 101], [100, 99, 90, 99, 99], C5, stop_dist=[d0, 3, 3, 3, 3], tp_pct=0.08)
    check(got[0] == [1, 1, 1, 0, 0] and got[1] == [("tp", 108.0)] and got[2] == [(1, "stop")]
          and len(got[3]) == 1 and "stop_dist" in got[3][0] and "exits_unarmed" in got[3][0],
          f"stop_dist {why} on the signal bar: no stop for that trade (Low 90 is held), take-profit still fires, "
          f"attrs['exits_unarmed'] + a RuntimeWarning ({got[:3]})")
got = dz([1, nan, 0, 1, nan, nan], [100] * 6, [100, 101, 101, 101, 101, 101], [100, 90, 100, 100, 100, 96], [100] * 6,
         stop_dist=[nan, nan, nan, 3, 3, 3])
check(got[:3] == ([1, 1, 0, 1, 1, 0], [("stop", 97.0)], [(1, "stop")]),
      f"…and only that trade: the next entry, with a valid distance, has its stop ({got[:3]})")
import lib.exits
with warnings.catch_warnings(record=True) as w2:
    warnings.simplefilter("always")
    for _ in range(3):
        r2 = apply_exits(pd.Series(L5, dtype=float), pd.DataFrame({"Open": F5, "Close": F5}), stop_dist=[nan] * 5)
check(len(w2) == 0 and len(r2.attrs["exits_unarmed"]) == 1,
      f"the warning is once per process (a scan calls the lib hundreds of times); attrs['exits_unarmed'] is on every result ({len(w2)} more)")
got = dz(L5, **TR, trail_dist=[nan, nan, nan, 2, 2])
check(got[:3] == ([1, 1, 1, 1, 0], [("trail", 108.0)], [(1, "trail")]),
      f"trail_dist NaN at the entry: reported, and the trail starts at its first valid reading ({got[:3]})")

# ── 1e. breakeven: armed by a bar reaching the threshold, in force from the next bar
BE = dict(breakeven_at=0.02, stop_pct=0.05)
got = dz(L5, F5, [100, 101, 102.5, 101, 101], [100, 99.5, 99.5, 99.8, 99], [100, 100, 101, 100.5, 100], **BE)
check(got[:2] == ([1, 1, 1, 0, 0], [("breakeven", 100.0)]),
      f"breakeven: bar 2 reaches +2% and dips under the fill in the same bar → no exit on it (order unknown, "
      f"not assumed); bar 3 back at 100 exits, order at the fill price ({got})")
got = dz(L5, F5, [100, 101, 101.9, 101, 101], [100, 99.5, 99.5, 99.8, 99], [100, 100, 101, 100.5, 100], **BE)
check(got[:2] == ([1, 1, 1, 1, 1], []), f"breakeven not reached (High 101.9 < 102): back at the fill price is no exit ({got})")
got = dz(L5, F5, [100, 101, 102.5, 101, 101], [100, 99.5, 94.5, 99.8, 99], [100, 100, 96, 100.5, 100], **BE)
check(got[:2] == ([1, 1, 0, 0, 0], [("stop", 95.0)]),
      f"one bar reaches the breakeven threshold AND the stop: it is a stop at 95, not a breakeven at 100 ({got})")
got = dz(L5, [100, 100, 101, 98, 98], [100, 101, 102.5, 99, 99], [100, 99.5, 100.5, 97, 97], [100, 100, 101, 98, 98], **BE)
check(got[:2] == ([1, 1, 1, 0, 0], [("breakeven", 98.0)]), f"breakeven armed, next bar gaps under the fill: order at the Open 98 ({got})")
got = dz(L5, F5, [100, 103, 101, 101, 101], [100, 99, 99.9, 100.5, 100.5], [100, 101, 100.5, 100.5, 100.5], **BE)
check(got[:2] == ([1, 1, 0, 0, 0], [("breakeven", 100.0)]),
      f"breakeven armed on the fill bar itself (High 103; its Low 99 is not an exit), exits on the next ({got})")
got = dz(L5, F5, F5, F5, [100, 100, 102.5, 99.9, 100], trigger="close", **BE)
check(got[:2] == ([1, 1, 1, 0, 0], [("breakeven", None)]), f"breakeven with trigger=\"close\": closes +2.5%, then closes under the fill ({got})")
got = dz(S5, F5, [100, 101, 100.5, 100.2, 101], [100, 99.5, 97.5, 99, 99], [100, 100, 99, 100, 100],
         breakeven_dist=[2, 20, 20, 20, 20])
check(got[:2] == ([-1, -1, -1, 0, 0], [("breakeven", 100.0)]),
      f"short breakeven_dist 2 (signal bar) → armed at 98 by Low 97.5, High 100.2 exits at the fill; no stop needed ({got})")

# ── 1f. cooldown_bars: re-enter the same side after N flat bars; N = 0 is the 2026-09-23 bug
def cd(sig, close, **kw):
    df = pd.DataFrame({"Open": [100.0] * len(close), "Close": close}, dtype=float)
    return [float(x) for x in apply_exits(pd.Series(sig, dtype=float), df, stop_pct=0.03, **kw).tolist()]

STATE8 = [1] * 8
got = cd(STATE8, [100, 96, 96, 100, 100, 100, 100, 100])
check(got == [1, 0, 0, 0, 0, 0, 0, 0], f"no cooldown_bars: stopped, flat until the base changes side — as before ({got})")
got = cd(STATE8, [100, 96, 96, 100, 100, 100, 100, 100], cooldown_bars=1)
check(got == [1, 0, 1, 1, 1, 1, 1, 1] and got.count(0.0) == 1, f"cooldown_bars=1: exactly one flat bar, then back in ({got})")
got = cd(STATE8, [100, 96, 96, 100, 100, 100, 100, 100], cooldown_bars=3)
check(got == [1, 0, 0, 0, 1, 1, 1, 1], f"cooldown_bars=3: three flat bars ({got})")
got = cd(STATE8, [100, 96, 96, 100, 96, 100, 100, 100], cooldown_bars=1)
check(got == [1, 0, 1, 1, 0, 1, 1, 1], f"the re-entry is a new trade: its stop is measured from its own fill, and it cools down again ({got})")
got = cd(STATE8, [100, 96, nan, 96, 100, 100, 100, 100], cooldown_bars=2)
check(got == [1, 0, 0, 0, 1, 1, 1, 1], f"cooldown counts valid bars only (the NaN bar is not one) ({got})")
got = cd([1, 1, 1, 0, 0, 0, 0, 0], [100, 96, 96, 100, 100, 100, 100, 100], cooldown_bars=1)
check(got == [1, 0, 1, 0, 0, 0, 0, 0], f"cooldown never holds past the base signal: the base goes flat, so does the position ({got})")
got = cd([1, 1, 1, -1, -1, -1], [100, 96, 96, 96, 96, 96], cooldown_bars=5)
check(got == [1, 0, 0, -1, -1, -1], f"a flip during the cooldown enters at once, as without one ({got})")

# ── 1g. long and short may differ: (long, short), None = that side off
def side_case(sig, close, **kw):
    df = pd.DataFrame({"Open": [100.0] * len(close), "Close": close}, dtype=float)
    return [float(x) for x in apply_exits(pd.Series(sig, dtype=float), df, **kw).tolist()]

check(side_case(L5, [100, 100, 96, 96, 96], stop_pct=(0.03, 0.05)) == [1, 1, 0, 0, 0]
      and side_case(S5, [100, 100, 104, 104, 104], stop_pct=(0.03, 0.05)) == [-1, -1, -1, -1, -1]
      and side_case(S5, [100, 100, 106, 106, 106], stop_pct=(0.03, 0.05)) == [-1, -1, 0, 0, 0],
      "stop_pct=(0.03, 0.05): a long stops at -3%, a short holds +4% and stops at +5%")
check(side_case(S5, [100, 100, 150, 150, 150], stop_pct=(0.03, None)) == [-1] * 5
      and side_case(L5, [100, 100, 96, 96, 96], stop_pct=(0.03, None)) == [1, 1, 0, 0, 0],
      "stop_pct=(0.03, None): shorts have no stop, longs do")
check(side_case([1] * 5, [100] * 5, max_bars=(2, None)) == [1, 1, 0, 0, 0]
      and side_case([-1] * 5, [100] * 5, max_bars=(2, None)) == [-1] * 5, "max_bars=(2, None): only longs are timed out")
got_l = dz(L5, F5, [100, 101, 104, 101, 101], [100, 99, 99, 99, 99], C5, tp_dist=([3, 9, 9, 9, 9], 6.0))
got_s = dz(S5, F5, H5, [100, 99, 95, 93, 99], C5, tp_dist=([3, 9, 9, 9, 9], 6.0))
check(got_l[:2] == ([1, 1, 0, 0, 0], [("tp", 103.0)]) and got_s[:2] == ([-1, -1, -1, 0, 0], [("tp", 94.0)]),
      f"tp_dist=(series, 6.0): longs take profit 3 away, shorts 6 away ({got_l[:2]} / {got_s[:2]})")

# ── 1h. argument validation of the new arguments
D1 = pd.DataFrame({"Open": [1.0, 1.0], "Close": [1.0, 1.0]})
S1 = pd.Series([1.0, 1.0])
for label, kw in (("stop_pct + stop_dist", dict(stop_pct=0.03, stop_dist=1.0)),
                  ("tp_pct + tp_dist", dict(tp_pct=0.03, tp_dist=1.0)),
                  ("trail_pct + trail_dist", dict(trail_pct=0.03, trail_dist=1.0)),
                  ("breakeven_at + breakeven_dist", dict(breakeven_at=0.03, breakeven_dist=1.0)),
                  ("stop_pct for longs + stop_dist for shorts", dict(stop_pct=(0.03, None), stop_dist=(None, 1.0))),
                  ("cooldown_bars=0 (the same-bar re-entry bug)", dict(stop_pct=0.03, cooldown_bars=0)),
                  ("cooldown_bars=-1", dict(stop_pct=0.03, cooldown_bars=-1)),
                  ("cooldown_bars=1.5", dict(stop_pct=0.03, cooldown_bars=1.5)),
                  ("cooldown_bars with no exit", dict(cooldown_bars=2)),
                  ("stop_dist=0", dict(stop_dist=0)),
                  ("stop_dist of the wrong length", dict(stop_dist=[1.0, 1.0, 1.0])),
                  ("stop_dist on another index", dict(stop_dist=pd.Series([1.0, 1.0], index=[5, 6]))),
                  ("a 3-tuple", dict(stop_pct=(0.03, 0.03, 0.03))),
                  ("breakeven_at=0", dict(breakeven_at=0)),
                  ("a negative fraction inside a tuple", dict(tp_pct=(0.05, -0.05)))):
    try:
        apply_exits(S1, D1, **kw)
        check(False, f"raises ValueError: {label}")
    except ValueError:
        check(True, f"raises ValueError: {label}")
try:
    apply_exits(S1, D1, 0.03, None, None, None, "close", 2.0)
    check(False, "the new arguments are keyword-only")
except TypeError:
    check(True, "the new arguments are keyword-only")


# ── 2. the loop the agent hand-wrote on 2026-09-23 (exit on the stop, then re-check the entry
#       STATE on the same bar) must fail the table — that is the pattern this lib replaces
def _agent_2026_09_23(sig, df, stop_pct=0.03, **_):
    base, close = sig.ffill().fillna(0.0).tolist(), df["Close"].tolist()
    out, pos, ep = [], 0, None
    for i, c in enumerate(close):
        if pos == 1 and (c <= ep * (1 - stop_pct) or base[i] <= 0):
            pos, ep = 0, None
        if pos == 0 and base[i] > 0:
            pos, ep = 1, c
        out.append(pos)
    return pd.Series(out, index=sig.index, dtype=float)

with np.errstate(all="ignore"):
    missed = failures(_agent_2026_09_23)
check(any("state-style base" in l for l, _ in missed), "the table catches the 2026-09-23 same-bar re-entry loop")


# ── 3. spot clamp
s = pd.Series([1.0, -1.0, nan, -0.5, 0.0])
check(clamp_spot(s, "spot").tolist()[:2] == [1.0, 0.0] and np.isnan(clamp_spot(s, "spot")[2])
      and clamp_spot(s, "spot").tolist()[3:] == [0.0, 0.0], "spot: shorts → 0, NaN (hold) kept")
check(clamp_spot(s, "swap") is s and clamp_spot(s, None) is s, "swap / no MARKET: returned untouched")

src = open(os.path.join(ROOT, "lib", "runner.py"), encoding="utf-8").read()
check("clamp_spot(signals, config.get('MARKET'))" in src, "lib/runner.py calls clamp_spot on the Type A signals")

WS = tempfile.mkdtemp(prefix="exits-runner-")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"), ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "strategies", "spot_t"))
with open(os.path.join(WS, "strategies", "spot_t", "strategy.py"), "w") as f:
    f.write('''import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
STRATEGY_NAME = "spot_t"
SYMBOL = "BTCUSDT"
MARKET = os.environ["T_MARKET"]
INTERVAL = "1h"
START = "2024-01-01"
END = None
FEE = 0.0005
def fetch_data(hdrs):
    import numpy as np, pandas as pd
    idx = pd.date_range("2024-01-01", periods=400, freq="h", tz="UTC")
    c = 100 * np.exp(np.cumsum(np.random.default_rng(1).normal(0, 0.01, 400)))
    return pd.DataFrame({"Open": c, "High": c, "Low": c, "Close": c, "Volume": 1.0}, index=idx)
def compute_signals(df):
    import numpy as np, pandas as pd
    s = pd.Series(np.where(np.arange(len(df)) // 20 % 2, 1.0, -1.0), index=df.index)
    return s.clip(lower=0.0) if os.environ.get("T_CLIP") else s
if __name__ == "__main__":
    from lib.runner import run
    run(locals(), fetch_data, compute_signals, None)
''')

def backtest(market, clip):
    env = dict(os.environ, BLAVE_MODE="backtest", T_MARKET=market, T_CLIP="1" if clip else "")
    stats = os.path.join(WS, "strategies", "spot_t", "stats.json")
    if os.path.exists(stats):
        os.unlink(stats)
    r = subprocess.run([sys.executable, "strategies/spot_t/strategy.py"], cwd=WS, env=env,
                       capture_output=True, text=True, timeout=300)
    if r.returncode or not os.path.exists(stats):
        return None, r.stdout + r.stderr
    d = json.load(open(stats))
    return (d.get("Total Return [%]"), d.get("Trades"), d.get("Max Drawdown [%]")), r.stdout

shorted, out = backtest("spot", False)
twin, _ = backtest("spot", True)
swap, _ = backtest("swap", False)
check(shorted is not None and shorted == twin, f"spot + shorts backtests exactly like its long-only twin ({shorted} vs {twin})")
check("clamped to flat" in out, "…and says so on stdout")
check(swap is not None and swap != shorted, f"swap keeps its shorts ({swap})")
shutil.rmtree(WS)

# quality_check: a spot Type A file that can emit shorts is flagged (scans bypass the runner clamp)
import ast
from lib.quality_check import _check_spot_short
HEAD = 'SYMBOL = "BTCUSDT"\nMARKET = "{m}"\n'
def spot_flags(body, market="spot"):
    return [f["msg"] for f in _check_spot_short(ast.parse(HEAD.format(m=market) + body))]
SHORT = "def compute_signals(df):\n    s = df.x * 0\n    s[df.x < 0] = -1.0\n    return s\n"
check(bool(spot_flags(SHORT)), "quality_check: spot + `s[...] = -1.0` → WARNING")
check(not spot_flags(SHORT, "swap"), "quality_check: swap + shorts → nothing")
check(not spot_flags(SHORT.replace("    return s", "    return s.clip(lower=0.0)")), "quality_check: spot + clip(lower=0.0) → nothing")
TP = "def compute_signals(df):\n    return threshold_position(df.x, 1, 0, {c}, {sh})\n"
check(bool(spot_flags(TP.format(c=-0.2, sh=-1))), "quality_check: spot + threshold_position with a reachable short → WARNING")
check(not spot_flags(TP.format(c="1e9", sh="-1e9")), "quality_check: spot + threshold_position short_th=-1e9 → nothing")
check(not spot_flags("def compute_signals(df):\n    return df.x.shift(-1) * 0\n"), "quality_check: shift(-1) is not a short")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
