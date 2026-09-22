"""Minimal check: a Type A live tick holds the backtest's position (ffill), not the last bar's raw signal.

Drives the real lib/runner.run() with BLAVE_MODE=live in a temp workspace — no network:

  - trailing NaNs after an exit (0) while state.json still says 1 (a tick skipped the
    exit bar) → state converges to 0 on this tick
  - the last bar carries a signal → same result as before (that signal)

Run: cd blave-agent && .venv/bin/python tests/check_live_ffill.py
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

import lib.runner as runner

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


NAME = "ffcheck"
WS = Path(tempfile.mkdtemp(prefix="live-ffill-"))
os.chdir(WS)                    # load_state/save_state are cwd-relative
runner._REPO_ROOT = WS
STATE = WS / "strategies" / NAME / "state.json"
STATE.parent.mkdir(parents=True)

n = 200
idx = pd.date_range("2024-01-01", periods=n, freq="h")
close = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 7.0)), index=idx)
DF = pd.DataFrame({"Open": close, "High": close * 1.001, "Low": close * 0.999,
                   "Close": close, "Volume": 1.0}, index=idx)


def live_tick(signals, prev_position, env_mode="live"):
    STATE.write_text(json.dumps({"position": prev_position}))
    config = {"STRATEGY_NAME": NAME, "SYMBOL": "BTCUSDT",   # no MODE key: inferred
              "INTERVAL": "1h", "START": "2024-01-01", "FEE": 0.0005, "MCPT": False}
    os.environ.pop("BLAVE_MODE", None)
    if env_mode:
        os.environ["BLAVE_MODE"] = env_mode
    try:
        runner.run(config, lambda hdrs: DF, lambda d: signals, send_telegram_fn=None)
    finally:
        os.environ.pop("BLAVE_MODE", None)
    return json.loads(STATE.read_text())["position"]


# entry at bar 150, exit at bar 195, NaN (hold) on the last 4 bars
missed_exit = pd.Series(np.nan, index=idx)
missed_exit.iloc[150] = 1.0
missed_exit.iloc[195] = 0.0
got = live_tick(missed_exit, 1.0)
check(got == 0.0, f"skipped exit bar → position converges to 0 (got {got})")

last_bar = pd.Series(np.nan, index=idx)
last_bar.iloc[150] = 0.0
last_bar.iloc[-1] = -1.0
got = live_tick(last_bar, 0.0)
check(got == -1.0, f"signal on the last bar → that signal, as before (got {got})")

# no BLAVE_MODE at all: being in the 下單設定 (amount 0 included) makes the run live + quiet
(WS / "manager").mkdir()
(WS / "manager" / "portfolio_config.json").write_text(
    json.dumps({"amounts": {NAME: 0}, "exchanges": {NAME: "binance"}}))
PNL = WS / "strategies" / NAME / "pnl.png"
got = live_tick(missed_exit, 1.0, env_mode=None)
check(got == 0.0 and not PNL.exists(),
      f"picked with amount 0, no BLAVE_MODE → live tick (state converges) and quiet (no pnl.png) (got {got})")

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
