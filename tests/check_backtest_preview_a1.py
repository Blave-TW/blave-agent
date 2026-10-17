"""Minimal check for the save dialog's previews (spec tw-holdings-a1 B1–B3).

lib/runner: a Type A backtest writes strategies/<name>/backtest_state.json — the position the
scheduler would write from the last bar (before clamp_spot), that bar's label and close, and
code_hash — and removes an older one when the scheduler would not compute that bar yet. A
Type C preview carries `closes` (the last row's close per held symbol).
runtime/portfolio_reporter.backtest_previews: unpicked strategies (drafts) are included, a
picked one with a state.json is not, code_hash must match, `latest` says whether the bar is
still the newest closed one, and at most PREVIEW_EXTRA_MAX drafts ride along.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_backtest_preview_a1.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="a1-preview-", dir=os.environ.get("SCRATCHPAD") or None))
os.environ["BLAVE_AGENT_WORKSPACE"] = str(WS)
os.environ["BLAVE_AGENT_BASE"] = str(WS)
os.environ.setdefault("MPLBACKEND", "Agg")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}

import numpy as np
import pandas as pd

import lib.runner as runner
from lib.strategy import code_hash

runner.dotenv_values = lambda *a, **k: {}
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(7)
IDX = pd.date_range("2025-01-01", periods=200, freq="D")
px = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, 200)))
DF = pd.DataFrame({"Open": px, "High": px * 1.01, "Low": px * 0.99, "Close": px, "Volume": 1.0}, index=IDX)
# the bar after the last one has not closed: the scheduler computes on DF's last row
runner._utcnow = lambda: (IDX[-1] + pd.Timedelta(days=1, hours=3)).to_pydatetime()


def strat(name, src, market="spot"):
    d = WS / "strategies" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "strategy.py").write_text(src)
    return d, {"STRATEGY_NAME": name, "SYMBOL": "BTCUSDT", "INTERVAL": "1d", "START": "2025-01-01",
               "FEE": 0.0005, "MCPT": False, "MARKET": market, "__file__": str(d / "strategy.py")}


def signals(df):
    s = pd.Series(np.where(df["Close"] > df["Close"].rolling(10).mean(), 1.0, np.nan), index=df.index)
    # by date, not position (a position-based tail would be look-ahead): short on the second-last bar, then held
    s[s.index == IDX[-2]] = -0.5
    s[s.index == IDX[-1]] = np.nan
    return s


def run(cfg, fetch, compute):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run(dict(cfg), fetch, compute)


SDIR, CFG = strat("ta", 'INTERVAL = "1d"\nMARKET = "spot"\n# Type A\n')
run(CFG, lambda h: DF.copy(), signals)
pv = json.loads((SDIR / runner.BACKTEST_STATE_FILE).read_text()) if (SDIR / runner.BACKTEST_STATE_FILE).exists() else None
check(pv is not None and pv["type"] == "signal" and pv["symbol"] == "BTCUSDT" and pv["market"] == "spot",
      f"Type A backtest writes a signal preview ({pv and {k: pv[k] for k in ('type', 'symbol', 'market')}})")
check(pv is not None and pv["position"] == -0.5,
      "…the last signal held by ffill, before clamp_spot (lib/portfolio clamps the net spot target)")
check(pv is not None and pv["close"] == float(DF["Close"].iloc[-1]) and pv["bar_at"] == int(IDX[-1].timestamp()),
      "…with the last bar's close and label (B3: shares = amount / close)")
check(pv is not None and pv["code_hash"] == code_hash((SDIR / "strategy.py").read_bytes()), "…stamped with code_hash")

# a minute after the close, the newest bar not in yet: inside the grace the scheduler waits for it
clock = runner._utcnow
runner._utcnow = lambda: (IDX[-1] + pd.Timedelta(days=1, minutes=1)).to_pydatetime()
run(CFG, lambda h: DF.iloc[:-1].copy(), signals)
kept = json.loads((SDIR / runner.BACKTEST_STATE_FILE).read_text()) if (SDIR / runner.BACKTEST_STATE_FILE).exists() else None
check(kept == pv, "data not computable yet: no new preview, the older one of the same code stays (the dialog still prices from it)")
(SDIR / runner.BACKTEST_STATE_FILE).write_text(json.dumps(dict(pv, code_hash="0" * 16)))
run(CFG, lambda h: DF.iloc[:-1].copy(), signals)
check(not (SDIR / runner.BACKTEST_STATE_FILE).exists(), "…an older one of other code is removed")
runner._utcnow = clock
run(CFG, lambda h: DF.copy(), signals)

# ── Type C carries closes for held symbols
CDIR, CCFG = strat("tc", 'INTERVAL = "1d"\nMARKET = "spot"\n# basket\n')
CL = pd.DataFrame({"AAAUSDT": px, "BBBUSDT": px[::-1].copy(), "CCCUSDT": px * 2}, index=IDX)


def basket(d):
    c, o = d
    w = np.zeros(c.shape)
    w[:, 0], w[:, 1] = 0.5, 0.5
    return w, pd.concat({"close": c, "open": o}, axis=1)


run(dict(CCFG, SYMBOL=None), lambda h: (CL.copy(), CL.copy()), basket)
cpv = json.loads((CDIR / runner.BACKTEST_STATE_FILE).read_text())
check(cpv["type"] == "portfolio" and cpv["market"] == "spot" and cpv["weights"] == {"AAAUSDT": 0.5, "BBBUSDT": 0.5, "CCCUSDT": 0.0}
      and cpv["bar_at"] == int(IDX[-1].timestamp()) and cpv["rebalance_at"] == int(IDX[0].timestamp()),
      "Type C preview keeps the 0.1.26 shape: last row's weights, its bar, the first bar of the unchanged run")
check(cpv.get("closes") == {"AAAUSDT": float(CL["AAAUSDT"].iloc[-1]), "BBBUSDT": float(CL["BBBUSDT"].iloc[-1])},
      f"Type C preview: closes of the held symbols only ({cpv.get('closes')})")

# ── the reporter
import portfolio_reporter as pr  # noqa: E402

NOW = runner._utcnow()
got = pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW)
a, c = got.get("ta"), got.get("tc")
check(a is not None and a["type"] == "signal" and a["position"] == -0.5 and a["close"] == pv["close"] and a["latest"] is True,
      f"unpicked (draft) Type A previewed, latest ({a})")
check(c is not None and c["weights"] == {"AAAUSDT": 0.5, "BBBUSDT": 0.5} and set(c["closes"]) == {"AAAUSDT", "BBBUSDT"},
      f"unpicked Type C previewed with closes ({c and c.get('closes')})")
check(a is not None and a["daily_tw"] is False and "code_hash" not in a, "crypto daily: daily_tw false; code_hash not forwarded")
later = pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW + timedelta(days=3)).get("ta")
check(later is not None and later["latest"] is False, "a newer bar has closed since: still forwarded, latest false")

(SDIR / "state.json").write_text(json.dumps({"symbol": "BTCUSDT", "position": 1.0}))
check("ta" not in pr.backtest_previews({"amounts": {"ta": 100.0}}, pr.strategy_states(), now=NOW),
      "picked and already has a state.json: no preview (the scheduler's signal is used)")
check("ta" in pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW),
      "unpicked with an old state.json: still previewed (the scheduler is not computing it)")
(SDIR / "state.json").unlink()

(SDIR / "strategy.py").write_text('INTERVAL = "1d"\nMARKET = "spot"\n# edited\n')
check("ta" not in pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW), "strategy.py changed since the backtest: none")

for i in range(pr.PREVIEW_EXTRA_MAX + 2):
    d = WS / "strategies" / f"x{i}"
    d.mkdir()
    (d / "strategy.py").write_text('INTERVAL = "1d"\n')
    (d / runner.BACKTEST_STATE_FILE).write_text(json.dumps(dict(cpv, code_hash=code_hash(b'INTERVAL = "1d"\n'))))
    os.utime(d / runner.BACKTEST_STATE_FILE, (time.time() + 10 + i, time.time() + 10 + i))
drafts = [n for n in pr.backtest_previews({"amounts": {}}, pr.strategy_states(), now=NOW) if n.startswith("x")]
check(sorted(drafts) == sorted(f"x{i}" for i in range(2, pr.PREVIEW_EXTRA_MAX + 2)),
      f"at most PREVIEW_EXTRA_MAX drafts, newest files first ({sorted(drafts)})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
