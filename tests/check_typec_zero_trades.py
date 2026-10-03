"""A Type C backtest whose weights never left zero is refused (2026-10-03: the data quota ran out
mid-fetch and a 0-trade backtest was filed as the strategy's result). Pins: SystemExit naming the
possible causes, no stats.json, no versions/; one trade is enough to pass; a live tick is never
refused.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typec_zero_trades.py
"""
import contextlib, io, os, shutil, sys, tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
import numpy as np
import pandas as pd
import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

WS = Path(tempfile.mkdtemp(prefix="typec-zero-"))
os.chdir(WS)
runner._REPO_ROOT = WS
IDX = pd.bdate_range("2024-01-02", periods=120)
CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(np.random.default_rng(3).normal(0, 0.01, (120, 3)), axis=0)),
                     index=IDX, columns=list("ABC"))
PRICE = pd.concat({"close": CLOSE, "open": CLOSE}, axis=1)

def run(name, w, mode="backtest"):
    os.environ["BLAVE_MODE"] = mode
    with contextlib.redirect_stdout(io.StringIO()):
        runner.run({"STRATEGY_NAME": name, "INTERVAL": "1d", "START": "2024-01-02", "FEE": 0.001},
                   lambda h: None, lambda d: (w, PRICE))
    return WS / "strategies" / name

zero = np.zeros(CLOSE.shape)
try:
    run("flat", zero)
    check(False, "0-trade backtest refused")
except SystemExit as e:
    msg = str(e)
    check("0 trades" in msg and "data missing" in msg and "never fires" in msg and "No backtest kept" in msg and "Backtest refused" not in msg,
          "0-trade backtest refused, naming the possible causes")
d = WS / "strategies" / "flat"
check(not (d / "stats.json").exists() and not (d / "versions").exists(), "no stats.json, no versions/")

one = zero.copy(); one[60:, 0] = 1.0
check((run("one", one) / "stats.json").exists(), "a single entry is enough — backtest completes")

try:
    run("flat_live", zero, mode="live")
    check(True, "live tick with zero weights is not refused")
except SystemExit as e:
    check(False, f"live tick with zero weights is not refused ({e})")

os.chdir(ROOT)
shutil.rmtree(WS, ignore_errors=True)
print(f"\n{'all pass' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
