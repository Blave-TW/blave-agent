"""Type A: the backtest's preview and the live tick agree on the same bars (QA 0.1.59 R3-10).

QA saw a new 4h channel strategy whose 進出場紀錄 ended on an open short (部位 -1) while its first
live tick in the portfolio wrote signal=0. Reproduced with this file's own strategy: the exit fired
on the LAST closed bar. The trade log is execution events — a signal on bar t trades at bar t+1's
open (w_curr = pos lagged one bar) — so that exit has no row yet and the log still ends on the short.
The live tick (lib/runner live path) and the backtest preview (backtest_state.json, what the save
dialog prices from) both read the last bar's signal, and both say flat. Not a runner bug: this pins
that the two live-facing numbers stay equal, and the one-bar lag of the log that explains the gap.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typea_live_parity.py
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="typea-live-", dir=os.environ.get("SCRATCHPAD") or None))
os.environ["BLAVE_AGENT_WORKSPACE"] = str(WS)
os.environ["BLAVE_AGENT_BASE"] = str(WS)
os.environ.setdefault("MPLBACKEND", "Agg")
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}

import numpy as np
import pandas as pd

import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


os.chdir(WS)
runner._REPO_ROOT = WS

N = 400
IDX = pd.date_range("2026-09-26", periods=N, freq="4h")
rng = np.random.default_rng(3)
px = 3000 * np.exp(np.cumsum(rng.normal(0, 0.01, N)))
px[-8:-1] = px[-9] * np.linspace(0.93, 0.90, 7)   # break down below the channel: short
px[-1] = px[-9] * 0.975                            # last closed bar back above the midline: exit
DF = pd.DataFrame({"Open": px, "High": px * 1.002, "Low": px * 0.998, "Close": px, "Volume": 1.0}, index=IDX)
runner._utcnow = lambda: (IDX[-1] + pd.Timedelta(hours=4, minutes=20)).to_pydatetime()


def channel(df, n=20):
    """Donchian breakout, exit at the midline once in a position (the exit depends on the position)."""
    hi = df["High"].rolling(n).max().shift(1)
    lo = df["Low"].rolling(n).min().shift(1)
    mid = (hi + lo) / 2
    s = pd.Series(np.nan, index=df.index)
    s[df["Close"] > hi] = 1.0
    s[df["Close"] < lo] = -1.0
    held = s.ffill().fillna(0).shift(1)
    s[(((held > 0) & (df["Close"] < mid)) | ((held < 0) & (df["Close"] > mid))) & s.isna()] = 0.0
    return s


SDIR = WS / "strategies" / "eth_ch"
SDIR.mkdir(parents=True)
(SDIR / "strategy.py").write_text('INTERVAL = "4h"\n# Type A\n')
CFG = {"STRATEGY_NAME": "eth_ch", "SYMBOL": "ETHUSDT", "INTERVAL": "4h", "START": "2026-09-26", "FEE": 0.0005,
       "MCPT": False, "MARKET": "swap", "WARMUP": 20, "__file__": str(SDIR / "strategy.py")}


def run(mode):
    os.environ["BLAVE_MODE"] = mode
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run(dict(CFG), lambda h: DF.copy(), channel)


sig = channel(DF)
check(sig.iloc[-1] == 0.0 and sig.ffill().iloc[-2] == -1.0, "fixture: short held into the last bar, exit signal on the last closed bar")

run("backtest")
stats = json.loads((SDIR / "stats.json").read_text())
pv = json.loads((SDIR / runner.BACKTEST_STATE_FILE).read_text())
last = stats["trades"][-1]
check(last["direction"] == "sell" and last["position"] == -1.0,
      f"trade log still ends on the short ({last['direction']} → {last['position']}): the exit trades at the next bar's open")
check(pv["position"] == 0.0 and pv["bar_at"] == int(IDX[-1].timestamp()),
      f"backtest preview = the last bar's signal (flat), what a live tick would write ({pv['position']})")

run("live")
state = json.loads((SDIR / "state.json").read_text())
check(state["position"] == pv["position"], f"live tick on the same bars = the preview ({state['position']} vs {pv['position']})")
logged = [l for l in (SDIR / "strategy.log").read_text().splitlines() if "signal=" in l]
check(bool(logged) and "signal=0.0000" in logged[-1], "strategy.log line the QA read: signal=0.0000")

os.chdir(ROOT)
shutil.rmtree(WS, ignore_errors=True)
print(f"\n{fails} FAILED" if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
