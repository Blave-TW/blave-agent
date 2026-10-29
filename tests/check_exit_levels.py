"""lib/exits.py stop_level / tp_level — the strategy's own absolute price level as a stop / take-profit.

  1. one minimal case per rule (which bar's value, touch, NaN, sides, only while holding, both on
     one bar, gap, close mode, roll bar, per-side tuple, trail alongside, what raises, a level <= 0,
     the cooldown re-entry gate, attrs exits_at_fill / exits_level_gaps), and on 20,000 bars: a level
     carried over from the previous trade plus cooldown_bars=1 does not loop exit / re-enter;
  2. an independent bar-by-bar reference on random series, positions and reasons;
  3. golden: no new argument → positions, attrs["exits"] and attrs["exits_unarmed"] identical to the
     2026-10-28-k lib (tests/_exits_2026_10_28k.py) — the shipped examples' signals and 400 random
     argument sets;
  4. speed: 40,000 bars, no new argument, at most 15% slower than the old lib (min of interleaved runs);
  5. the lib-capability guards: lib/quality_check.py names an apply_exits argument this lib lacks
     (and its list equals the signature), lib/runner.py turns the TypeError into "a typo, or a newer
     lib" with the closest argument;
  6. a stop_level strategy through the real pipeline: run() backtest with the look-ahead check,
     MCPT and the 成交測試 grid, then scan_grid and run_walk_forward; a level built from future
     bars is refused as 偷看未來; the two stop_level code blocks of references/strategy-code.md run.
Run: cd blave-agent && .venv/bin/python tests/check_exit_levels.py
"""
import contextlib, importlib.util, inspect, io, json, os, sys, tempfile, time, warnings
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
import numpy as np, pandas as pd
from lib.exits import apply_exits

warnings.simplefilter("ignore", RuntimeWarning)
fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

nan = np.nan
_spec = importlib.util.spec_from_file_location("exits_old", os.path.join(ROOT, "tests", "_exits_2026_10_28k.py"))
_old = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_old)
old_apply = _old.apply_exits


def frame(o, h, l, c, inst=None):
    df = pd.DataFrame({"Open": o, "High": h, "Low": l, "Close": c}, dtype=float)
    if inst is not None:
        df["instrument_id"] = inst
    return df


def run(sig, df, **kw):
    r = apply_exits(pd.Series(sig, dtype=float), df, **kw)
    return r.tolist(), r.attrs["exits"]


def reasons(ex):
    return list(ex["reason"])


# ── 1. rules ────────────────────────────────────────────────────────────────────
F = [100.0] * 5
# bar t is tested with the level of bar t-1: bar 2's own level (99) would hit its Low 99.5, bar 1's (98) does not
pos, ex = run([1, nan, nan, nan, nan], frame(F, F, [100, 99.5, 99.5, 99.5, 97], F), trigger="intrabar",
              stop_level=pd.Series([98, 98, 99, 98, 98.0]))
check(pos == [1, 1, 1, 1, 0] and reasons(ex) == ["stop_level"] and ex["order_price"].tolist() == [98.0],
      "long: Low reaching the level of the bar BEFORE exits (not the bar's own level); order_price = the level")
pos, _ = run([1, nan, nan], frame([100] * 3, [100] * 3, [100, 98, 100], [100] * 3), trigger="intrabar",
             stop_level=pd.Series([98.0, 98, 98]))
check(pos == [1, 0, 0], "a Low exactly at the level counts (at or past, like every other exit)")
pos, ex = run([1, nan, nan, nan], frame([100] * 4, [100] * 4, [100, 97, 97, 97], [100] * 4), trigger="intrabar",
              stop_level=pd.Series([nan, nan, 98, 98.0]))
check(pos == [1, 1, 1, 0] and len(ex) == 1, "NaN = no level on that bar (bars 1–2 untested), not carried forward")
pos, ex = run([-1, nan, nan, nan], frame([100] * 4, [100, 101, 102, 100], [99] * 4, [100] * 4), trigger="intrabar",
              stop_level=pd.Series([102.0] * 4))
check(pos == [-1, -1, 0, 0] and reasons(ex) == ["stop_level"], "short: High reaching the level exits")
pos, ex = run([1, nan, nan], frame([100] * 3, [100, 103, 100], [100] * 3, [100] * 3), trigger="intrabar",
              tp_level=pd.Series([103.0] * 3))
check(pos == [1, 0, 0] and reasons(ex) == ["tp_level"] and ex["order_price"].tolist() == [103.0],
      "long tp_level: High reaching it exits at the level")
pos, ex = run([-1, nan, nan], frame([100] * 3, [100] * 3, [100, 96, 100], [100] * 3), trigger="intrabar",
              tp_level=pd.Series([97.0] * 3))
check(pos == [-1, 0, 0] and reasons(ex) == ["tp_level"], "short tp_level: Low reaching it exits")
pos, ex = run([0, nan, nan, 0], frame([100] * 4, [200] * 4, [1] * 4, [100] * 4), trigger="intrabar",
              stop_level=pd.Series([99.0] * 4), tp_level=pd.Series([101.0] * 4))
check(pos == [0, 0, 0, 0] and ex.empty, "flat: levels change nothing")
pos, ex = run([1, nan, nan], frame([100] * 3, [100, 104, 100], [100, 96, 100], [100] * 3), trigger="intrabar",
              stop_level=pd.Series([97.0] * 3), tp_level=pd.Series([103.0] * 3))
check(pos == [1, 0, 0] and reasons(ex) == ["stop_level"], "one bar touching both: the stop (losing side assumed)")
pos, ex = run([1, nan, nan, nan], frame([100, 100, 104, 100], [100, 100, 105, 100], [100, 100, 96, 100], [100] * 4),
              trigger="intrabar", stop_level=pd.Series([97.0] * 4), tp_level=pd.Series([103.0] * 4))
check(pos == [1, 1, 0, 0] and reasons(ex) == ["tp_level"] and ex["order_price"].tolist() == [104.0],
      "…unless the bar OPENED beyond the take-profit: tp_level at the Open")
pos, ex = run([1, nan, nan, nan], frame([100, 100, 95, 95], [100, 100, 96, 96], [100, 100, 94, 94], [100, 100, 95, 95]),
              trigger="intrabar", stop_level=pd.Series([98.0] * 4))
check(pos == [1, 1, 0, 0] and ex["order_price"].tolist() == [95.0], "gap through the level: order_price is the Open")
pos, ex = run([1, nan, nan, nan], frame([100] * 4, [100] * 4, [100, 90, 90, 90], [100, 99, 97, 97]),
              trigger="close", stop_level=pd.Series([98.0] * 4))
check(pos == [1, 1, 0, 0] and reasons(ex) == ["stop_level"] and ex["order_price"].isna().all(),
      'trigger="close": a Low through the level does not count, a Close through it does; no order_price')
pos, ex = run([1, nan, nan], frame([100, 97, 97], [100, 98, 98], [100, 96, 96], [100, 97, 97]), trigger="intrabar",
              stop_level=pd.Series([98.0] * 3))
check(pos == [1, 0, 0] and ex["order_price"].tolist() == [97.0], "a fill already beyond the level exits at once (at the fill)")
pos, ex = run([1, nan, nan, nan], frame([100, 100, 110, 110], [100, 100, 110, 110], [100, 100, 99, 99], [100, 100, 110, 110],
                                        inst=["A", "A", "B", "B"]), trigger="intrabar", stop_level=pd.Series([99.0] * 4))
check(pos == [1, 1, 1, 0], "roll bar tests no level (its value is the old contract's price); the next bar does")
pos, _ = run([1, nan, -1, nan, nan], frame([100] * 5, [100, 100, 100, 103, 100], [100, 97, 100, 100, 100], [100] * 5),
             trigger="intrabar", stop_level=(pd.Series([98.0] * 5), None))
check(pos == [1, 0, -1, -1, -1], "(long, None): the long stop fires, the short has none")
pos, ex = run([1, nan, nan, nan], frame([100] * 4, [100, 110, 110, 110], [100, 100, 104, 104], [100, 110, 105, 105]),
              trigger="intrabar", stop_level=pd.Series([90.0] * 4), trail_pct=0.05)
check(pos == [1, 1, 0, 0] and reasons(ex) == ["trail"], "trail_pct alongside stop_level: the trail still fires")
pos, ex = run([1, nan, nan, nan, 1, nan], frame([100] * 6, [100] * 6, [100, 97, 100, 100, 100, 100], [100] * 6),
              trigger="intrabar", stop_level=pd.Series([98.0] * 6))
check(pos == [1, 0, 0, 0, 0, 0], "after a stop_level exit: flat until the base signal changes side (a repeated 1 is not a new entry)")
pos, _ = run([1, nan, nan, nan, 1, nan], frame([100] * 6, [100] * 6, [100, 97, 100, 100, 100, 100], [100] * 6),
             trigger="intrabar", stop_level=pd.Series([98.0] * 6), cooldown_bars=2)
check(pos == [1, 0, 0, 1, 1, 1], "cooldown_bars re-enters after a stop_level exit")
d3 = frame([100] * 3, [100] * 3, [100] * 3, [100] * 3)
for kw, what in ((dict(stop_level=pd.Series([98.0] * 3), stop_pct=0.03), "stop_level + stop_pct"),
                 (dict(stop_level=pd.Series([98.0] * 3), stop_dist=2.0), "stop_level + stop_dist"),
                 (dict(stop_level=pd.Series([98.0] * 3), breakeven_at=0.02), "stop_level + breakeven_at"),
                 (dict(stop_level=(pd.Series([98.0] * 3), None), stop_pct=(None, 0.03)), "stop_level long + stop_pct short"),
                 (dict(tp_level=pd.Series([103.0] * 3), tp_pct=0.03), "tp_level + tp_pct"),
                 (dict(stop_level=98.0), "a number, not a Series"),
                 (dict(stop_level=pd.Series([98.0] * 3, index=[5, 6, 7])), "a Series on another index")):
    try:
        apply_exits(pd.Series([1.0, nan, nan]), d3, trigger="intrabar", **kw)
        check(False, f"{what} raises")
    except ValueError:
        check(True, f"{what} raises")
pos, _ = run([1, nan, nan], frame([100] * 3, [100] * 3, [100, 97, 100], [100] * 3), trigger="intrabar",
             stop_level=pd.Series([98.0] * 3), tp_pct=0.5, max_bars=10)
check(pos == [1, 0, 0], "stop_level alone counts as an exit, and mixes with tp_pct / max_bars")
import lib.exits as _ex
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    _ex._level_warned.clear()
    pos, ex = run([1, nan, nan, nan], frame([100] * 4, [100] * 4, [100, 99, 97, 97], [100] * 4), trigger="intrabar",
                  stop_level=pd.Series([-5.0, 0.0, 98, 98]))
check(pos == [1, 1, 1, 0] and reasons(ex) == ["stop_level"]
      and any("stop_level was <= 0 on 2 bar(s)" in str(x.message) for x in w),
      "a level <= 0: no level on that bar (no raise — a live tick must not die on it), warned")

# cooldown ends with the Close still past the same level: no re-entry until a new level (96) appears
G = frame([100, 100, 97, 97, 99, 99], [100] * 6, [100, 97, 96.5, 98.5, 98.5, 98.5], [100, 97, 97, 99, 99, 99])
pos, _ = run([1, nan, nan, nan, nan, nan], G, trigger="intrabar", stop_level=pd.Series([98.0, 98, 98, 98, 96, 96]),
             cooldown_bars=1)
check(pos == [1, 0, 0, 0, 1, 1], "cooldown + Close past the level: waits (even after the Close recovers) for a new level")
pos, _ = run([1, nan, nan, nan, nan, nan], G, trigger="intrabar", stop_level=pd.Series([98.0, 98, 98, 98, 99.5, 96]),
             cooldown_bars=1)
check(pos == [1, 0, 0, 0, 0, 1], "…a new level the Close is also past keeps waiting; the next new one re-enters")
pos, _ = run([1, nan, nan, nan, nan, nan], G, trigger="intrabar", stop_level=pd.Series([98.0, 98, nan, nan, 96, 96]),
             cooldown_bars=1)
check(pos == [1, 0, 0, 0, 1, 1], "…a NaN level when the cooldown ends counts as the trade's last one (98), like a NaN while waiting")
pos, _ = run([1, nan, nan, nan, nan, nan], G, trigger="intrabar", tp_level=pd.Series([150.0, 99, 99, 99, 99, 120]),
             cooldown_bars=1)
check(pos == [1, 1, 0, 0, 0, 1], "tp_level: a cooldown ending with the Close at or above it waits for a new level")
pos, _ = run([1, nan, nan, 0, 1, nan], G, trigger="intrabar", stop_level=pd.Series([98.0] * 6), cooldown_bars=1)
check(pos == [1, 0, 0, 0, 1, 1], "…the base signal changing side re-enters as before, level or not")
r = apply_exits(pd.Series([1, nan, nan, 0, 1, nan]), frame([100, 100, 97, 97, 99, 97], [100] * 6,
                [100, 97, 96, 96, 98.5, 97], [100, 97, 97, 99, 99, 97]), trigger="intrabar", stop_level=pd.Series([98.0] * 6))
af = r.attrs["exits_at_fill"]
check(r.tolist() == [1, 0, 0, 0, 1, 0] and af.to_dict("records") == [{"time": 5, "exit": "stop_level", "level": 98.0, "fill": 97.0}],
      "a trade exiting on its fill bar with the fill already past the level → a row in attrs['exits_at_fill']")
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    _ex._level_warned.clear()
    r = apply_exits(pd.Series([1, nan, nan, nan, 0, 1, nan, nan, nan]), frame(*[[100.0] * 9] * 4), trigger="intrabar",
                    stop_level=pd.Series([nan] * 5 + [90.0] * 4))
gp = r.attrs["exits_level_gaps"]
check(gp.to_dict("records") == [{"time": 1, "exit": "stop_level", "bars": 4, "nan_bars": 4}]
      and any("NaN on more than half the bars" in str(x.message) for x in w),
      "a trade with no level on most of its bars → one row in attrs['exits_level_gaps'] + a warning; the next trade none")
r0 = apply_exits(pd.Series([1.0, nan, nan]), d3, stop_pct=0.03, trigger="intrabar")
check("exits_at_fill" not in r0.attrs and "exits_level_gaps" not in r0.attrs, "no level given: neither attrs key exists")

# probe data: 20,000 bars, an MA-cross base and a breakout-low stop
rng3 = np.random.default_rng(3)
c3 = 100 * np.exp(np.cumsum(rng3.normal(0, 0.008, 20000))); o3 = np.r_[c3[0], c3[:-1]] * (1 + rng3.normal(0, 0.002, 20000))
P = pd.DataFrame({"Open": o3, "High": np.maximum(o3, c3) * 1.004, "Low": np.minimum(o3, c3) * 0.996, "Close": c3},
                 index=pd.date_range("2022-01-01", periods=20000, freq="1h"))
f3, s3 = P["Close"].rolling(20).mean(), P["Close"].rolling(60).mean()
PSIG = pd.Series(np.where(f3 > s3, 1.0, np.where(f3 < s3, 0.0, nan)), index=P.index)
P_ON = PSIG.ffill() > 0
P_BRK = P_ON & (P["Close"] >= P["Close"].rolling(10).max())
P_STALE = P["Low"].where(P_BRK).ffill()                         # carries the previous trade's low
P_FIXED = P["Low"].where(P_BRK | (P_ON & ~P_ON.shift(1, fill_value=False))).ffill().where(P_ON)


def trades(r):
    return int(((r != 0) & (r.shift(1).fillna(0) == 0)).sum())


for name, lv in (("previous trade's level", P_STALE), ("per-trade level", P_FIXED)):
    r = apply_exits(PSIG, P, stop_level=lv, tp_pct=0.06, cooldown_bars=1, trigger="intrabar")
    ref = trades(apply_exits(PSIG, P, stop_pct=0.005, tp_pct=0.06, cooldown_bars=1, trigger="intrabar"))
    af0 = len(apply_exits(PSIG, P, stop_level=lv, tp_pct=0.06, trigger="intrabar").attrs["exits_at_fill"])
    n_af = len(r.attrs["exits_at_fill"])
    # before the gate: 3,962 trades, 2,750 of them out on their fill bar (vs 93 without cooldown)
    check(trades(r) <= ref and n_af <= af0 + 0.05 * trades(r),
          f"20,000 bars, {name} + cooldown_bars=1: {trades(r)} trades (stop_pct=0.005 + cooldown: {ref}), "
          f"{n_af} out on their fill bar ({af0} without cooldown) — the cooldown adds no exit / re-enter loop")
r = apply_exits(PSIG, P, stop_level=P_STALE, tp_pct=0.06, trigger="intrabar")
check(len(r.attrs["exits_at_fill"]) > 50, f"…a previous trade's level, no cooldown: the {len(r.attrs['exits_at_fill'])} "
                                          f"trades exiting on their fill are listed in attrs['exits_at_fill']")


# ── 2. independent reference ────────────────────────────────────────────────────
def reference(sig, o, h, l, c, sl, tl, intrabar):
    base = pd.Series(sig, dtype=float).ffill().fillna(0.0).to_numpy()
    out, rs, held, stopped, first = np.zeros(len(base)), [], 0.0, False, False
    for t in range(len(base)):
        s = np.sign(held)
        if s and not stopped:
            lo, hi = (l[t], h[t]) if intrabar else (c[t], c[t])
            bad, good = (lo, hi) if s > 0 else (hi, lo)
            a, b = sl[t - 1], tl[t - 1]
            r = None
            if intrabar and a == a and (o[t] - a) * s <= 0: r = "stop_level"
            elif intrabar and b == b and (o[t] - b) * s >= 0: r = "tp_level"
            elif a == a and (bad - a) * s <= 0: r = "stop_level"
            elif b == b and (good - b) * s >= 0: r = "tp_level"
            if r:
                stopped = True; rs.append(r)
        if stopped and t and np.sign(base[t]) != np.sign(base[t - 1]):
            stopped = False
        out[t] = held = 0.0 if stopped else base[t]
    return out.tolist(), rs


bad, n_ex = [], 0
for seed in range(300):
    r = np.random.default_rng(seed)
    n = int(r.integers(10, 200))
    c = 100 * np.exp(np.cumsum(r.normal(0, 0.02, n)))
    o = np.r_[c[0], c[:-1]] * (1 + r.normal(0, 0.004, n))
    h, l = np.maximum(o, c) * (1 + np.abs(r.normal(0, 0.01, n))), np.minimum(o, c) * (1 - np.abs(r.normal(0, 0.01, n)))
    sig = r.choice([1.0, -1.0, 0.0, nan], n, p=[.1, .1, .05, .75])
    sl = np.where(r.random(n) < 0.8, c * (1 + r.choice([-1, 1], n) * r.uniform(0.005, 0.04, n)), nan)
    tl = np.where(r.random(n) < 0.6, c * (1 + r.choice([-1, 1], n) * r.uniform(0.01, 0.06, n)), nan)
    ib = bool(r.random() < 0.6)
    got = apply_exits(pd.Series(sig), frame(o, h, l, c), trigger="intrabar" if ib else "close",
                      stop_level=pd.Series(sl), tp_level=pd.Series(tl))
    want = reference(sig, o, h, l, c, sl, tl, ib)
    n_ex += len(want[1])
    if got.tolist() != want[0] or list(got.attrs["exits"]["reason"]) != want[1]:
        bad.append(seed)
check(not bad and n_ex > 1000, f"300 random series: positions and reasons = an independent bar-by-bar reference "
                               f"({n_ex} exits; differing seeds {bad[:5]})")


# ── 3. golden: no new argument → the 2026-10-28-k lib, bar for bar ──────────────
def same(a, b):
    return (a.tolist() == b.tolist()
            and repr(a.attrs["exits"].to_dict("records")) == repr(b.attrs["exits"].to_dict("records"))
            and repr(a.attrs["exits_unarmed"].to_dict("records")) == repr(b.attrs["exits_unarmed"].to_dict("records")))


rng = np.random.default_rng(7)
NB = 6000
IDX = pd.date_range("2024-01-01", periods=NB, freq="1h")
cl = 100 * np.exp(np.cumsum(rng.normal(0, 0.008, NB)))
op = np.r_[cl[0], cl[:-1]] * (1 + rng.normal(0, 0.002, NB))
BARS = pd.DataFrame({"Open": op, "High": np.maximum(op, cl) * 1.004, "Low": np.minimum(op, cl) * 0.996,
                     "Close": cl, "Volume": 1.0}, index=IDX)
atr = (BARS["High"] - BARS["Low"]).rolling(14).mean()
OLD_ARGS = [dict(stop_pct=0.03, trigger="intrabar"), dict(stop_pct=0.02, tp_pct=0.05, trigger="intrabar"),
            dict(trail_pct=0.04, max_bars=48, trigger="close"), dict(stop_dist=2 * atr, tp_dist=3 * atr, trigger="intrabar"),
            dict(trail_dist=2 * atr, trigger="intrabar"), dict(stop_pct=0.03, breakeven_at=0.02, cooldown_bars=3, trigger="intrabar"),
            dict(stop_pct=(0.03, None), tp_pct=(None, 0.04), trigger="close")]
diff = []
for ex_name in ("btc_sma_cross", "cl_sma", "tsmc_ma", "txf_ma_1m"):
    spec = importlib.util.spec_from_file_location("ex_" + ex_name, os.path.join(ROOT, "examples", ex_name, "strategy.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    sig = m.compute_signals(BARS.copy())
    sig = sig[0] if isinstance(sig, tuple) else sig
    for kw in OLD_ARGS:
        if not same(old_apply(sig, BARS, **kw), apply_exits(sig, BARS, **kw)):
            diff.append((ex_name, sorted(kw)))
check(not diff, f"4 shipped examples × {len(OLD_ARGS)} old argument sets: bar for bar the 2026-10-28-k lib (differing {diff[:3]})")


def rand_old_args(r, df, n):
    kw = {}
    dist = pd.Series(np.abs(r.normal(0, 2, n)) + r.choice([0.0, nan], n, p=[.9, .1]), index=df.index)
    for k, vals in (("stop_pct", [0.01, 0.03]), ("tp_pct", [0.02, 0.05]), ("trail_pct", [0.02, 0.05])):
        if r.random() < .35:
            kw[k] = float(r.choice(vals)) if r.random() < .7 else (float(r.choice(vals)), None)
    for k in ("stop_dist", "tp_dist", "trail_dist", "breakeven_dist"):
        pk = "breakeven_at" if k == "breakeven_dist" else k.replace("_dist", "_pct")
        if pk not in kw and r.random() < .3:
            kw[k] = dist if r.random() < .7 else ((dist, None) if r.random() < .5 else (None, dist))
    if r.random() < .25: kw["max_bars"] = int(r.integers(1, 12)) if r.random() < .7 else (int(r.integers(1, 12)), None)
    if r.random() < .25 and "breakeven_dist" not in kw: kw["breakeven_at"] = 0.01 if r.random() < .7 else (None, 0.02)
    if r.random() < .25: kw["cooldown_bars"] = int(r.integers(1, 4))
    if not any(k in kw for k in ("stop_pct", "tp_pct", "trail_pct", "stop_dist", "tp_dist", "trail_dist",
                                 "max_bars", "breakeven_at")):
        kw["stop_pct"] = 0.03
    kw["trigger"] = str(r.choice(["close", "intrabar"]))
    return kw


diff, n_ex = [], 0
for seed in range(400):
    r = np.random.default_rng(1000 + seed)
    n = int(r.integers(5, 150))
    c = 100 * np.exp(np.cumsum(r.normal(0, r.choice([0.005, 0.02]), n)))
    o = np.r_[c[0], c[:-1]] * (1 + r.normal(0, 0.004, n))
    h, l = np.maximum(o, c) * (1 + np.abs(r.normal(0, 0.01, n))), np.minimum(o, c) * (1 - np.abs(r.normal(0, 0.01, n)))
    for arr in (o, h, l, c):
        mk = r.random(n) < 0.04
        arr[mk] = r.choice([nan, 0.0], mk.sum())
    df = frame(o, h, l, c, inst=np.cumsum(r.random(n) < 0.08) if r.random() < 0.4 else None)
    sig = pd.Series(r.choice([1.0, -1.0, 0.0, nan, 0.5, -0.5], n, p=[.15, .12, .1, .55, .05, .03]))
    kw = rand_old_args(r, df, n)
    a, b = old_apply(sig, df, **kw), apply_exits(sig, df, **kw)
    n_ex += len(a.attrs["exits"])
    if not same(a, b):
        diff.append(seed)
check(not diff and n_ex > 1000, f"400 random series × random old arguments: identical to the 2026-10-28-k lib "
                                f"({n_ex} exits; differing seeds {diff[:5]})")

# the combos the random draw rarely makes, on the 6,000-bar series, with and without instrument_id
INST = BARS.assign(instrument_id=np.cumsum(np.random.default_rng(11).random(NB) < 0.002))
SIG2 = pd.Series(np.where(BARS["Close"].rolling(20).mean() > BARS["Close"].rolling(60).mean(), 1.0, -1.0), index=IDX)
COMBOS = [dict(stop_pct=0.02, breakeven_dist=1.5 * atr), dict(breakeven_dist=(atr, None), trail_pct=0.03),
          dict(stop_dist=(2 * atr, None), tp_dist=(None, 3 * atr)), dict(trail_dist=(2 * atr, 3 * atr), max_bars=(24, None)),
          dict(stop_pct=(0.03, 0.05), breakeven_at=(0.01, 0.02), cooldown_bars=2),
          dict(max_bars=(10, 30), tp_pct=0.04, cooldown_bars=5), dict(stop_dist=50.0, tp_dist=2.0, breakeven_dist=1.0)]
diff = []
for d in (BARS, INST):
    for sg in (SIG2, SIG2 * 0.5, SIG2.clip(lower=0)):
        for kw in COMBOS:
            for trig in ("close", "intrabar"):
                if not same(old_apply(sg, d, trigger=trig, **kw), apply_exits(sg, d, trigger=trig, **kw)):
                    diff.append((sorted(kw), trig))
check(not diff, f"{2 * 3 * len(COMBOS) * 2} breakeven_dist / per-side / instrument_id / half-size combos: identical "
                f"to the 2026-10-28-k lib (differing {diff[:3]})")
from lib.strategy import ladder_position
lad = ladder_position(SIG2 > 0, BARS, [0.02, 0.04])
a, b = old_apply(lad, BARS, max_bars=50, trigger="close"), apply_exits(lad, BARS, max_bars=50, trigger="close")
check(same(a, b) and a.attrs.get("ladder") == b.attrs.get("ladder"), "a ladder_position signal: same result, ladder attrs kept")


# ── 4. speed ────────────────────────────────────────────────────────────────────
NS = 40000
r = np.random.default_rng(0)
c = 100 * np.exp(np.cumsum(r.normal(0, 0.01, NS))); o = np.r_[c[0], c[:-1]]
DS = pd.DataFrame({"Open": o, "High": np.maximum(o, c) * 1.003, "Low": np.minimum(o, c) * 0.997, "Close": c},
                  index=pd.date_range("2020-01-01", periods=NS, freq="1h"))
fa, sa = DS["Close"].rolling(20).mean(), DS["Close"].rolling(50).mean()
SIG = pd.Series(np.where(fa > sa, 1.0, np.where(fa < sa, -1.0, nan)), index=DS.index)
EV = SIG.ne(SIG.shift()) & SIG.notna()
LV = DS["Low"].where(EV & (SIG > 0)).combine_first(DS["High"].where(EV & (SIG < 0))).ffill()


def best_of(fn, kw, k):
    return min(_timed(fn, kw) for _ in range(k))


def _timed(fn, kw):
    t = time.perf_counter(); fn(SIG, DS, **kw); return time.perf_counter() - t


for kw in (dict(stop_pct=0.03, tp_pct=0.06, trigger="intrabar"), dict(stop_pct=0.03, trail_pct=0.05, trigger="close")):
    to = tn = 1e9
    for _ in range(9):                     # interleaved, so a slow moment hits both sides
        to, tn = min(to, _timed(old_apply, kw)), min(tn, _timed(apply_exits, kw))
    check(tn <= to * 1.15, f"40,000 bars, {sorted(k for k in kw if k != 'trigger')} {kw['trigger']}: "
                           f"old {to * 1e3:.1f} ms, new {tn * 1e3:.1f} ms ({tn / to - 1:+.1%}, limit +15%)")
tl_ms = best_of(apply_exits, dict(stop_level=LV, tp_pct=0.06, trigger="intrabar"), 5) * 1e3
check(tl_ms < 2000, f"40,000 bars with stop_level + tp_pct: {tl_ms:.1f} ms")


# ── 5. lib-capability guards ────────────────────────────────────────────────────
from lib import quality_check as qc
import lib.runner as runner
check(set(inspect.signature(apply_exits).parameters) == qc._APPLY_EXITS_KWARGS,
      "quality_check's apply_exits argument list = the signature")
tmpd = tempfile.mkdtemp(prefix="exitlv-", dir=os.environ.get("SCRATCHPAD") or None)
def qc_of(src):
    p = os.path.join(tmpd, "s.py"); open(p, "w").write(src); return qc.check(p)
HEAD = 'SYMBOL = "BTCUSDT"\nFEE = 0.0005\n'
newer = qc_of(HEAD + "def compute_signals(df):\n    from lib.exits import apply_exits\n"
              "    return apply_exits((df.Close > 1).astype(float), df, stop_pct=0.03, entry_level=df.Low, trigger='intrabar')\n")
check([f["check"] for f in newer] == ["lib_caps"] and newer[0]["level"] == "CRITICAL"
      and "entry_level" in newer[0]["msg"] and "a typo, or a strategy written on a newer lib" in newer[0]["msg"]
      and "fix the name" in newer[0]["msg"] and "更新" in newer[0]["msg"] and "stop_level" in newer[0]["msg"],
      "quality_check: an apply_exits argument this lib lacks → CRITICAL lib_caps: typo or newer lib, the arguments it takes")
typo = qc_of(HEAD + "def compute_signals(df):\n    from lib.exits import apply_exits\n"
             "    return apply_exits((df.Close > 1).astype(float), df, stop_pcts=0.03, trigger='intrabar')\n")
check(len(typo) == 1 and "Did you mean stop_pct=?" in typo[0]["msg"], f"quality_check: a typo gets the closest argument ({typo[0]['msg'][:90]!r})")
cur = qc_of(HEAD + "def compute_signals(df):\n    from lib.exits import apply_exits\n"
            "    return apply_exits((df.Close > 1).astype(float), df, stop_level=df.Low, tp_level=df.High, trigger='intrabar')\n")
check(not any(f["check"] == "lib_caps" for f in cur), "quality_check: stop_level / tp_level are this lib's own — no finding")

try:
    apply_exits(SIG, DS, stop_pct=0.03, entry_level=1)
except TypeError as e:
    te = e
try:
    runner._raise_if_newer_lib(te)
    check(False, "runner: an unknown apply_exits argument → SystemExit saying update")
except SystemExit as e:
    check("apply_exits() has no argument entry_level=" in str(e) and "a typo, or a strategy written on a newer lib" in str(e)
          and "stop_level" in str(e) and "更新" in str(e) and "Traceback" not in str(e),
          f"runner: an unknown apply_exits argument → SystemExit: typo or newer lib, the arguments it takes ({str(e)[:80]!r})")
from lib.strategy import threshold_position
try:
    threshold_position(pd.Series([1.0]), buy=1, sell_th=0, cover_th=0, short_th=0)
except TypeError as e:
    te3 = e
try:
    runner._raise_if_newer_lib(te3)
    check(False, "runner: a typo in a lib function's argument → the closest argument")
except SystemExit as e:
    check("Did you mean buy_th=?" in str(e) and "fix the name" in str(e), f"runner: a typo → the closest argument ({str(e)[:90]!r})")
def get_levels(df, n=3): return df
try:
    get_levels(None, m=2)
except TypeError as e:
    te4 = e
try:
    runner._raise_if_newer_lib(te4)
    check(True, "runner: the strategy's own get_* function with a bad argument stays a plain TypeError")
except BaseException as e:
    check(False, f"runner: the strategy's own get_* function with a bad argument stays a plain TypeError ({type(e).__name__}: {str(e)[:80]})")
def own(x): return x
try:
    own(1, y=2)
except TypeError as e:
    te2 = e
try:
    runner._raise_if_newer_lib(te2)
    check(True, "runner: the strategy's own function with a bad argument is not called a newer lib")
except SystemExit:
    check(False, "runner: the strategy's own function with a bad argument is not called a newer lib")


# ── 6. the real pipeline ────────────────────────────────────────────────────────
import lib.data as D
from lib.param_scan import scan_grid
from lib.walk_forward import run_walk_forward
import lib.validation as V

runner.dotenv_values = lambda *a, **k: {}
WS = Path(tempfile.mkdtemp(prefix="exitlv-ws-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"
D.fetch_kline = lambda symbol, interval, start, end, headers, max_retries=6: BARS.copy()


def fetch(hdrs):
    from lib.data import fetch_kline
    return fetch_kline("SYN", "1h", "2024-01-01", None, hdrs)


def lv_signals(df, fast=20, slow=60, tp=0.06, cooldown=1):
    f, s = df["Close"].rolling(fast).mean(), df["Close"].rolling(slow).mean()
    sig = pd.Series(np.where(f > s, 1.0, np.where(f < s, 0.0, nan)), index=df.index)
    on = sig.ffill() > 0
    event = (on & ~on.shift(1, fill_value=False)) | (on & (df["Close"] >= df["Close"].rolling(10).max()))
    return apply_exits(sig, df, stop_level=df["Low"].where(event).ffill().where(on), tp_pct=tp,
                       cooldown_bars=cooldown, trigger="intrabar")


n_cd, n_flat = trades(lv_signals(BARS)), trades(lv_signals(BARS, cooldown=None))
_f, _s = BARS["Close"].rolling(20).mean(), BARS["Close"].rolling(60).mean()
n_pct = trades(apply_exits(pd.Series(np.where(_f > _s, 1.0, np.where(_f < _s, 0.0, nan)), index=IDX), BARS,
                           stop_pct=0.005, tp_pct=0.06, cooldown_bars=1, trigger="intrabar"))
check(n_cd <= n_pct and n_cd <= 8 * n_flat,
      f"the pipeline strategy: {n_cd} trades with cooldown_bars=1, {n_flat} without, {n_pct} for stop_pct=0.005 + cooldown")


def leak_signals(df):
    f, s = df["Close"].rolling(20).mean(), df["Close"].rolling(60).mean()
    sig = pd.Series(np.where(f > s, 1.0, np.where(f < s, 0.0, nan)), index=df.index)
    return apply_exits(sig, df, stop_level=df["Low"].shift(-3), cooldown_bars=1, trigger="intrabar")


def backtest(name, compute, **cfg):
    config = {"STRATEGY_NAME": name, "SYMBOL": "SYN", "INTERVAL": "1h", "START": "2024-01-01", "FEE": 0.0005,
              "WARMUP": 60, "MCPT": True, "MCPT_N": 50, **cfg}
    out, refused = io.StringIO(), None
    with contextlib.redirect_stdout(out):
        try:
            runner.run(config, fetch, compute, send_telegram_fn=None)
        except SystemExit as e:
            refused = str(e)
    p = WS / "strategies" / name / "stats.json"
    return refused, out.getvalue(), json.loads(p.read_text()) if p.exists() else None


os.environ["BLAVE_QUIET"], os.environ[runner.EXEC_TEST_ENV] = "1", "1"
refused, out, stats = backtest("lv_ok", lv_signals)
check(refused is None and stats is not None and "Look-ahead check: passed" in out,
      "stop_level strategy: backtest written, look-ahead check ran and passed" + (f" — {refused[:200]!r}" if refused else ""))
check(stats is not None and stats.get(V.MCPT_P_KEY) is not None and runner.EXEC_TEST_KEY in stats,
      "…MCPT p-value and the 成交測試 grid are in stats.json")
refused, _, stats = backtest("lv_leak", leak_signals)
check(bool(refused) and "偷看未來" in refused and stats is None, "a stop_level built from future bars (shift(-3)) is refused as 偷看未來")
del os.environ["BLAVE_QUIET"], os.environ[runner.EXEC_TEST_ENV]


def newer_signals(df):
    sig = (df["Close"] > df["Close"].rolling(20).mean()).astype(float)
    return apply_exits(sig, df, stop_pct=0.03, entry_level=df["Low"], trigger="intrabar")


refused, _, stats = backtest("lv_newer", newer_signals)
check(bool(refused) and "更新" in refused and "entry_level" in refused and stats is None,
      "run(): a strategy calling apply_exits with an argument this lib lacks stops with the update sentence")

grid = scan_grid(BARS, lv_signals, [10, 20, 30], [0.04, 0.06, 0.08], row_param="fast", col_param="tp",
                 fee=0.0005, valid_fn=lambda a, b: True, warmup=60)
g = np.asarray(grid[0] if isinstance(grid, tuple) else grid, dtype=float)
check(g.shape == (3, 3) and np.isfinite(g).all() and np.unique(g.round(6)).size > 1,
      f"scan_grid over a stop_level strategy: every cell scored, and they differ ({g.round(2).tolist()})")
wf_dir = WS / "wf"; wf_dir.mkdir()
run_walk_forward(BARS, lv_signals, [10, 20, 30], [0.04, 0.06, 0.08], str(wf_dir), "FAST", "TP", fee=0.0005,
                 row_kw="fast", col_kw="tp", lookback_days=60, step_days=30, valid_fn=lambda a, b: True, warmup=60)
wf = json.loads((wf_dir / "wf.json").read_text())
check(len(wf.get("runs", [])) >= 3 and len(wf.get("excluded_runs", [])) < len(wf["runs"]),
      f"run_walk_forward over a stop_level strategy: wf.json with {len(wf.get('runs', []))} runs, "
      f"{len(wf.get('excluded_runs', []))} excluded")

# the two stop_level code blocks of references/strategy-code.md, run as written
doc = Path(ROOT, "references", "strategy-code.md").read_text()
blocks = [b.split("```", 1)[0] for b in doc.split("```python\n")[1:]]
lvl = [b for b in blocks if "stop_level=level" in b]
reent = [b for b in blocks if "hit = df['Low'] <= stop.shift(1)" in b]
ok_doc = len(lvl) == 1 and len(reent) == 1
if ok_doc:
    ns = {}
    exec(lvl[0], ns)
    exec(reent[0], ns)
    a = ns["compute_signals"](BARS.copy())
    ns2 = {}
    exec(lvl[0], ns2)
    b = ns2["compute_signals"](BARS.copy())
    ok_doc = (trades(a) > 10 and set(np.unique(a)) <= {0.0, 1.0} and len(b.attrs["exits"]) > 10
              and len(b.attrs["exits_at_fill"]) <= 0.05 * trades(b) and b.attrs["exits_level_gaps"].empty)
check(ok_doc, "references/strategy-code.md: the per-trade stop_level example and the re-entry recipe run; the example's "
              "stops are not carried-over levels")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
