"""Enumerating check: a Type C preview exists exactly when it is the row the scheduler computes.

lib/runner writes the preview only if lib.bar_ready.computes_now says a tick would compute on
the backtest's data at that moment. For each way a member's last bar can be missing, the same
data goes through a backtest (the preview) and through the real scheduled tick
(manager/wait_for_bar._tick → lib.runner.run in live mode → state.json), at the same clock:

  1. missing only on the newest bar (Taiwan daily labels, evening): the tick computes now, the
     member excluded — preview = that state.json row
  2. suspended for days: past its grace, the tick primes without it — preview = state.json row
  3. one bar behind, inside its grace: the tick waits and computes once the bar lands, on other
     data — no preview, and the row it later computes differs from the backtest's last row
  4. never had any data: the tick never computes — no preview

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typec_preview_parity.py
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="typec-parity-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS

spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
wfb._alert_failure = lambda: types.SimpleNamespace(alert=lambda *a: None)
wfb._alert_stale = lambda *a, **k: None

CLOCK = {"now": None}


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        n = CLOCK["now"]
        return n.replace(tzinfo=timezone.utc) if tz else n


wfb.datetime = FakeDT
runner._utcnow = lambda: CLOCK["now"]

D = datetime(2026, 9, 18)                       # the newest bar's label
IDX = pd.date_range(end=D, periods=120, freq="D")
SYMS = ["AAA", "BBB", "CCC", "DDD", "XXX"]
rng = np.random.default_rng(11)
BASE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.02, (len(IDX), len(SYMS))), axis=0)),
                    index=IDX, columns=SYMS)


def compute(data):
    c, o = data
    mom = c.pct_change(5, fill_method=None)
    ok = c.notna() & mom.notna()                 # a member with no bar is left out, as real ones do
    rank = mom.where(ok).rank(axis=1, ascending=False, method="first")
    w = pd.DataFrame(np.where((rank <= 2) & ok, 0.5, 0.0), index=c.index, columns=c.columns)
    return w.values, pd.concat({"close": c, "open": o}, axis=1)


def frames(close):
    return close, close.shift(1).fillna(close.iloc[0])


def setup(name):
    d = WS / "strategies" / name
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    (d / "strategy.py").write_text(f'INTERVAL = "1d"\nMARKET = "spot"\n# {name}\n')
    shutil.rmtree(WS / "state" / "bar_wait", ignore_errors=True)
    return d, {"STRATEGY_NAME": name, "INTERVAL": "1d", "START": "2026-01-01", "FEE": 0.001,
               "WARMUP": 6, "MARKET": "spot", "__file__": str(d / "strategy.py")}


def run(config, close, mode):
    os.environ["BLAVE_MODE"] = mode
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run(dict(config), lambda h: frames(close.copy()), compute)


def backtest(d, config, close):
    run(config, close, "backtest")
    p = d / runner.BACKTEST_STATE_FILE
    return json.loads(p.read_text()) if p.exists() else None


def scheduled_tick(d, config, close):
    """The real wait_for_bar tick; its strategy run is lib.runner.run in live mode in-process."""
    wfb._load_strategy_module = lambda n: types.SimpleNamespace(INTERVAL="1d", fetch_data=lambda h: frames(close.copy()))
    wfb._run_strategy_protected = lambda n: run(config, close, "live") or True
    with contextlib.redirect_stdout(io.StringIO()):
        wfb._tick(config["STRATEGY_NAME"])
    p = d / "state.json"
    return json.loads(p.read_text()) if p.exists() else None


def row(s):
    return None if s is None else (s["weights"], s["bar_at"], s["rebalance_at"])


TPE_EVENING = D + timedelta(hours=9, minutes=30)     # 17:30 Taipei on D: expected = D-1 (Taiwan date labels)
JUST_CLOSED = D + timedelta(days=1, minutes=2)       # 00:02 UTC after D closed: expected = D, grace to 00:05

# 1. missing only on the newest bar
close = BASE.copy()
close.loc[D, "XXX"] = np.nan
CLOCK["now"] = TPE_EVENING
d, cfg = setup("only_today")
pv, live = backtest(d, cfg, close), scheduled_tick(d, cfg, close)
check(pv is not None and live is not None and row(pv) == row(live),
      f"1 missing only on the newest bar: the tick computes now and the preview is its row ({row(pv)} vs {row(live)})")

# 2. suspended for days
close = BASE.copy()
close.loc[D - timedelta(days=4):, "XXX"] = np.nan
d, cfg = setup("suspended")
pv, live = backtest(d, cfg, close), scheduled_tick(d, cfg, close)
check(pv is not None and live is not None and row(pv) == row(live),
      f"2 suspended for days: past its grace the tick primes without it, preview = that row ({row(pv)} vs {row(live)})")

# 3. one bar behind, inside its grace
close = BASE.copy()
close.loc[D, "XXX"] = np.nan
CLOCK["now"] = JUST_CLOSED
d, cfg = setup("in_grace")
os.environ["BLAVE_MODE"] = "backtest"
w_bt, _ = compute(frames(close))
pv, live = backtest(d, cfg, close), scheduled_tick(d, cfg, close)
check(pv is None and live is None, f"3 one bar behind inside its grace: the tick waits, no preview (preview={pv is not None}, state={live is not None})")
landed = BASE.copy()
landed.loc[D, "XXX"] = landed.loc[D - timedelta(days=1), "XXX"] * 1.5   # the late bar lands, and it moves
CLOCK["now"] = JUST_CLOSED + timedelta(minutes=1)
later = scheduled_tick(d, cfg, landed)
bt_last = dict(zip(SYMS, np.round(w_bt[-1], 10)))
check(later is not None and later["weights"] != bt_last,
      f"…the row the tick computes once it lands is not the backtest's last row ({later and later['weights']} vs {bt_last})")

# 4. never had any data
close = BASE.copy()
close["XXX"] = np.nan
CLOCK["now"] = TPE_EVENING
d, cfg = setup("never")
pv, live = backtest(d, cfg, close), scheduled_tick(d, cfg, close)
check(pv is None and live is None, f"4 a member that never had data: the tick never computes, no preview (preview={pv is not None}, state={live is not None})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
