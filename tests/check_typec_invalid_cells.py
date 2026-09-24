"""Minimal check: a Type C backtest does not book -100% on an asset whose bar has Open or
Close 0 / NaN (the runner cannot drop a bar for one asset, so the cell becomes a no-move bar
and the next valid bar's overnight leg spans the gap).

Asset A carries the real CCF rows from cache/twfutures_60m_CCF 2020-05-13/14 (Open 0 with a
valid Close, then Open 0 and Close 0); asset B is flat. Held 50/50 throughout.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typec_invalid_cells.py
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

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="typec-cells-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

IDX = pd.DatetimeIndex(["2020-05-13 00:00", "2020-05-13 01:00", "2020-05-13 02:00", "2020-05-13 03:00",
                        "2020-05-13 04:00", "2020-05-13 05:00", "2020-05-14 00:00", "2020-05-14 01:00",
                        "2020-05-14 02:00", "2020-05-14 03:00", "2020-05-14 04:00", "2020-05-14 05:00"])
A_OPEN  = [15.35, 15.40, 15.50, 15.50, 15.50, 15.60, 0.00, 15.45, 15.50, 0.00, 15.45, 15.35]
A_CLOSE = [15.40, 15.50, 15.50, 15.55, 15.60, 15.60, 15.50, 15.50, 15.50, 0.00, 15.35, 15.35]
close = pd.DataFrame({"A": A_CLOSE, "B": 100.0}, index=IDX)
opn = pd.DataFrame({"A": A_OPEN, "B": 100.0}, index=IDX)
opn.loc[IDX[4], "B"] = np.nan                   # a NaN Open on the other asset, too


def compute(data):
    c, o = data
    w = np.full(c.shape, 0.5)
    return w, pd.concat({"close": c, "open": o}, axis=1)


with contextlib.redirect_stdout(io.StringIO()):
    runner.run({"STRATEGY_NAME": "cells", "INTERVAL": "60m", "START": "2020-05-13", "FEE": 0.0,
                "MCPT": False}, lambda h: (close.copy(), opn.copy()), compute)
stats = json.loads((WS / "strategies" / "cells" / "stats.json").read_text())
ret = stats["Total Return [%]"]
check(ret is not None and ret > -5, f"50% in an asset with Open-0 / Close-0 bars: no -50% hit (got {ret}%)")

c2, o2 = runner._fill_invalid_cells(close.to_numpy(), opn.to_numpy())
check(o2[6, 0] == 15.60 and c2[6, 0] == 15.50, "Open-0 cell: Open = previous valid Close, Close kept (the real move stays)")
check(o2[9, 0] == 15.50 and c2[9, 0] == 15.50, "Open-0 + Close-0 cell: both = last valid Close (no move)")
check(o2[4, 1] == 100.0, "NaN Open on another asset: filled the same way")
lead = runner._fill_invalid_cells(np.array([[np.nan], [10.0]]), np.array([[np.nan], [10.0]]))
check(np.isnan(lead[0][0, 0]), "cells before an asset's first valid bar stay NaN (pre-listing)")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
