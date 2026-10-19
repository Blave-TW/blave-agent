"""Minimal check: a hand-run (no BLAVE_MODE) of a US-stock strategy that is in the 下單設定 is
an inferred live tick, and lib.data's Yahoo gate must see it — refuse, write no state.json.
Before the fix the gate read only the env var, let Yahoo through, and the runner wrote a
state.json the scheduled ticks (refused) could never update; the reconciler kept trading it.

  - picked, no BLAVE_MODE            → UsStockNotHere, no state.json
  - picked, BLAVE_MODE=backtest      → the escape hatch still fetches
  - not picked, no BLAVE_MODE        → a backtest, fetches
  - BLAVE_MODE is unset again after every run() (a second in-process run infers its own mode)

No network: fetch_data_fn calls the real gate (lib.data._us_require_desktop) and returns a frame.

Run: cd blave-agent && .venv/bin/python tests/check_inferred_live_us_gate.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import numpy as np
import pandas as pd

import lib.data as data
import lib.runner as runner

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


NAME = "us_amzn"
WS = Path(tempfile.mkdtemp(prefix="inferred-live-us-"))
os.chdir(WS)
runner._REPO_ROOT = WS
STATE = WS / "strategies" / NAME / "state.json"
STATE.parent.mkdir(parents=True)
(WS / "manager").mkdir()
CFG = WS / "manager" / "portfolio_config.json"

n = 120
idx = pd.date_range("2024-01-01", periods=n, freq="D")
close = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 5.0)), index=idx)
DF = pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close, "Volume": 1.0}, index=idx)
SIG = pd.Series(np.nan, index=idx)
SIG.iloc[60] = 1.0

fetched = []


def fetch(hdrs):
    data._us_require_desktop()
    fetched.append(1)
    return DF


def go(env_mode):
    fetched.clear()
    os.environ.pop("BLAVE_MODE", None)
    if env_mode:
        os.environ["BLAVE_MODE"] = env_mode
    config = {"STRATEGY_NAME": NAME, "SYMBOL": "AMZN", "INTERVAL": "1d", "START": "2024-01-01",
              "FEE": 0.0005, "MCPT": False}
    err = None
    try:
        runner.run(config, fetch, lambda d: SIG, send_telegram_fn=None)
    except data.UsStockNotHere as e:
        err = e
    after = os.environ.get("BLAVE_MODE")
    os.environ.pop("BLAVE_MODE", None)
    return err, after


os.environ["BLAVE_AGENT_LOCAL"] = "1"
os.environ.pop("BLAVE_SCHEDULED_RUN", None)

CFG.write_text(json.dumps({"amounts": {NAME: 100}, "exchanges": {NAME: "paper"}}))
err, after = go(None)
check(isinstance(err, data.UsStockNotHere), f"picked + no BLAVE_MODE → UsStockNotHere (got {err!r})")
check(not fetched, "picked + no BLAVE_MODE → Yahoo never reached")
check(not STATE.exists(), "picked + no BLAVE_MODE → no state.json written")
check(after is None, f"BLAVE_MODE restored after the inferred-live run (got {after!r})")

err, after = go("backtest")
check(err is None and fetched, f"picked + BLAVE_MODE=backtest → fetches (err {err!r})")
check(after == "backtest", f"explicit BLAVE_MODE left as given (got {after!r})")

CFG.write_text(json.dumps({"amounts": {}, "exchanges": {}}))
err, after = go(None)
check(err is None and fetched, f"not picked + no BLAVE_MODE → backtest, fetches (err {err!r})")
check(not STATE.exists(), "not picked → no state.json")
check(after is None, f"BLAVE_MODE still unset (got {after!r})")

print("FAIL" if fails else "OK", f"({fails} failed)")
sys.exit(1 if fails else 0)
