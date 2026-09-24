"""Minimal check: a bar with a valid Close but Open 0 is dropped by the runner's invalid-bar
filter instead of booking overnight = 0 / close[t-1] - 1 = -100%.

Rows are the real ones from cache/twfutures_60m_CCF (2020-05-13 .. 2020-05-14, 聯電期):
05-14 00:00 has Open 0 / Close 15.50 (the case the old Close-only filter let through) and
05-14 03:00 has Open 0 / Close 0 (already dropped before). Held long throughout.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_runner_open_zero.py
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

import pandas as pd

import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="open-zero-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

#            time                 Open   High   Low    Close  Volume
ROWS = [("2020-05-13 00:00", 15.35, 15.40, 15.35, 15.40,   4.0),
        ("2020-05-13 01:00", 15.40, 15.50, 15.40, 15.50, 200.0),
        ("2020-05-13 02:00", 15.50, 15.65, 15.50, 15.50, 532.0),
        ("2020-05-13 03:00", 15.50, 15.55, 15.50, 15.55,  46.0),
        ("2020-05-13 04:00", 15.50, 15.60, 15.50, 15.60, 138.0),
        ("2020-05-13 05:00", 15.60, 15.65, 15.50, 15.60, 264.0),
        ("2020-05-14 00:00",  0.00, 15.50,  0.00, 15.50,   8.0),
        ("2020-05-14 01:00", 15.45, 15.50,  0.00, 15.50, 194.0),
        ("2020-05-14 02:00", 15.50, 15.55,  0.00, 15.50, 140.0),
        ("2020-05-14 03:00",  0.00, 15.50,  0.00,  0.00, 176.0),
        ("2020-05-14 04:00", 15.45, 15.45, 15.35, 15.35, 106.0),
        ("2020-05-14 05:00", 15.35, 15.35, 15.20, 15.35, 538.0)]
DF = pd.DataFrame([r[1:] for r in ROWS], columns=["Open", "High", "Low", "Close", "Volume"],
                  index=pd.DatetimeIndex([r[0] for r in ROWS]))

config = {"STRATEGY_NAME": "ccf_open0", "SYMBOL": "CCF", "INTERVAL": "60m",
          "START": "2020-05-13", "FEE": 0.0, "MCPT": False}
with contextlib.redirect_stdout(io.StringIO()):
    runner.run(config, lambda hdrs: DF.copy(), lambda df: pd.Series(1.0, index=df.index))
stats = json.loads((WS / "strategies" / "ccf_open0" / "stats.json").read_text())

ret = stats["Total Return [%]"]
held = DF["Close"].iloc[-1] / DF["Open"].iloc[1] - 1          # entry at bar 1's open, out at last close
check(abs(ret - held * 100) < 0.05,
      f"long through an Open-0 bar books the real move {held * 100:.3f}%, not -100% (got {ret}%)")
ts = {int(pd.Timestamp("2020-05-14 00:00").timestamp()), int(pd.Timestamp("2020-05-14 03:00").timestamp())}
check(not any(c[0] in ts for c in stats.get("candles", [])),
      "both invalid bars are out of the bars the backtest computed on")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
