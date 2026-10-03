"""Minimal check: 'Trades' counts only weight changes that survive the 4-dp rounding the
runner writes into stats['trades'] (|Δw| ≥ 0.00005), so the backtest's trade count equals the
number of rows the trade list shows. Official #102 (SOL Supertrend, vol-scaled) showed
Trades 2168 vs 2107 listed rows — every one of the 61 extra was a micro-adjustment that the
list wrote as delta 0.0. Type C and walk-forward use the same definition.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_trade_count.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.runner as runner
from lib.analysis import count_trades

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


check(count_trades([0.0, 1e-16, 4e-5, -4e-5, np.nan, 6e-5, -0.5, 1.0]) == 3,
      "1e-16 noise, |Δw| 0.00004 and nan are not trades; 0.00006 / -0.5 / 1.0 are")
check(count_trades(np.array([[0.0, 3e-5], [0.2, -1e-9], [0.0, -0.1]])) == 2,
      "Type C (2-D): counted per cell, same threshold")

WS = Path(tempfile.mkdtemp(prefix="trade-count-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(3)
IDX = pd.date_range("2024-01-01", periods=300, freq="D")
CLOSE = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.02, 300))), index=IDX)
DF = pd.DataFrame({"Open": CLOSE.shift(1).fillna(100.0), "High": CLOSE * 1.01, "Low": CLOSE * 0.99,
                   "Close": CLOSE, "Volume": 1.0})
# long/short flips every 30 bars, plus a 0.00003 wobble on every other bar in between
BASE = np.where((np.arange(300) // 30) % 2 == 0, 1.0, -1.0)
SIG = pd.Series(BASE + np.where(np.arange(300) % 2 == 0, 3e-5, 0.0), index=IDX)

with contextlib.redirect_stdout(io.StringIO()):
    runner.run({"STRATEGY_NAME": "wobble", "SYMBOL": "X", "INTERVAL": "1d", "START": "2024-01-01",
                "FEE": 0.0005, "MCPT": False}, lambda h: DF.copy(), lambda df: SIG.copy())
st = json.loads((WS / "strategies" / "wobble" / "stats.json").read_text())
listed = sum(1 for t in st["trades"] if t["delta"] != 0)
check(st["Trades"] == listed and listed > 0,
      f"Type A: Trades = rows the trade list shows ({st['Trades']} vs {listed})")
raw = int(np.count_nonzero(np.diff(np.concatenate([[0.0], SIG.values]))))
check(st["Trades"] < raw, f"the 0.00003 wobble is not counted (raw weight changes {raw})")

COLS = list("AB")
C2 = pd.DataFrame({c: CLOSE.values * (1 + i * 0.1) for i, c in enumerate(COLS)}, index=IDX)
O2 = C2.shift(1).fillna(C2.iloc[0])


def compute_c(data):
    c, o = data
    w = np.full(c.shape, 0.4)
    w[100:, 0] = 0.1                                      # one real rebalance on A
    w[np.arange(len(c)) % 2 == 0, 1] += 2e-5              # B wobbles by 0.00002
    return w, pd.concat({"close": c, "open": o}, axis=1)


with contextlib.redirect_stdout(io.StringIO()):
    runner.run({"STRATEGY_NAME": "pfw", "INTERVAL": "1d", "START": "2024-01-01", "FEE": 0.0005, "WARMUP": 0},
               lambda h: (C2.copy(), O2.copy()), compute_c)
sc = json.loads((WS / "strategies" / "pfw" / "stats.json").read_text())
check(sc["Trades"] == 3, f"Type C: opening A and B + the rebalance on A = 3, wobble on B ignored (got {sc['Trades']})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
