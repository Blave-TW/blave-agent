"""lib/exits.py — apply_exits (stop / take-profit / trailing / time stop) and clamp_spot. No network.

  1. a case table run against lib.exits.apply_exits;
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
