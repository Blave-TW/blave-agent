"""Minimal check: a Type C member that stopped trading does not hold readiness, a live member
behind still does, and the scheduler records the bar and names the dead member once.

  1. a member 10 years behind (2361 in twstock_momentum): ready, straggler is a live member
  2. a Taiwan stock the CDN manifest says did not trade on the expected day: ready; not
     decided while the manifest does not reach that day
  3. a live member one bar behind: not ready, straggler is that member
  4. the whole frame behind (weekend, CDN late): no member is dead
  5. a tick on (1): last_processed_bar is set, the notice is sent once, not on the next bar
  6. the backtest warns, naming the dead member

Run: cd blave-agent && .venv/bin/python tests/check_bar_ready_dead_member.py
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
from datetime import datetime, timedelta
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.bar_ready as br
import lib.data as data
import lib.runner as runner

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


ws = tempfile.mkdtemp(prefix="bar-ready-dead-", dir=os.environ.get("SCRATCHPAD") or None)
cdn = Path(ws) / "twstock_cdn"
cdn.mkdir()
(cdn / "manifest.json").write_text(json.dumps({"asof": "2026-10-16", "stocks": {
    "2330": ["twse", 1, "2026-10-16"], "2317": ["twse", 1, "2026-10-16"],
    "2361": ["twse", 1, "2015-12-25"], "2409": ["twse", 1, "2026-10-15"]}}))
data._tw_cdn_dir = lambda: cdn

idx = pd.bdate_range("2015-12-01", "2026-10-16")
close = pd.DataFrame({"2330": 1.0, "2317": 1.0, "2361": 1.0}, index=idx)
close.loc[close.index > "2015-12-25", "2361"] = np.nan
expected = datetime(2026, 10, 16)
td = timedelta(days=1)
inactive = data.tw_not_trading(close.columns)
check(inactive == {"2361"}, f"tw_not_trading reads the cached manifest ({inactive})")

seen, ready, who, latest = br.judge((close, close), expected, (), td)
check(ready and who != "2361" and seen == expected and "2361" in latest,
      f"(1) 10 years behind, by the frame rule alone: ready ({ready}, {who}, {seen})")

susp = close.drop(columns="2361").assign(**{"2409": 1.0})
susp.iloc[-1, susp.columns.get_loc("2409")] = np.nan
_, ready, _, _ = br.judge((susp, susp), expected, data.tw_not_trading(susp.columns, "2026-10-16"), td)
_, ready_without, _, _ = br.judge((susp, susp), expected, (), td)
check(ready and not ready_without, f"(2) not traded on the CDN's last day: ready only with the manifest ({ready}, {ready_without})")
check(data.tw_not_trading(susp.columns, "2026-10-19") == set(),
      "(2) …but not for a day the manifest does not reach yet (2409 may trade on it)")

lag = close.copy()
lag.iloc[-1, lag.columns.get_loc("2317")] = np.nan
seen, ready, who, _ = br.judge((lag, lag), expected, inactive, td)
check(not ready and who == "2317" and seen == datetime(2026, 10, 15),
      f"(3) a live member one bar behind: not ready, named ({ready}, {who}, {seen})")

behind = close.iloc[:-5]
_, ready, who, latest = br.judge((behind, behind), expected, (), td)
check(not ready and br.dead_members(latest, (), td) == ["2361"],
      f"(4) the whole frame behind: not ready, only the long-dead member dead ({ready}, {who})")
hourly = {"BTC": datetime(2026, 10, 19, 0), "TXF": datetime(2026, 10, 16, 17)}
check(br.dead_members(hourly, (), timedelta(hours=1)) == [],
      "(4) TXF over a weekend on 1h (55 bars behind BTC): not dead")


# ── (5) the tick ─────────────────────────────────────────────────────────────
spec = importlib.util.spec_from_file_location("wfb_dead", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
sent = []
sys.modules["lib.notify"] = types.SimpleNamespace(send_text=lambda t: sent.append(t))
sys.modules["lib.events"] = types.SimpleNamespace(emit=lambda *a, **k: None)
os.chdir(ws)
os.makedirs("strategies/demo")
frame = {"df": close}
wfb._load_strategy_module = lambda n: types.SimpleNamespace(INTERVAL="1d", fetch_data=lambda h: (frame["df"],) * 2)
wfb._tw_stock_daily = lambda n: False
ran = []
wfb._run_strategy_protected = lambda n: ran.append(n) or True
clock = {"now": datetime(2026, 10, 17, 9, 0)}


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return clock["now"].replace(tzinfo=tz)


wfb.datetime = FakeDT
with contextlib.redirect_stdout(io.StringIO()):
    wfb._tick("demo")
st = json.load(open("state/bar_wait/demo.json"))
check(ran == ["demo"] and st["last_processed_bar"] == "2026-10-16T00:00:00",
      f"(5) the tick runs and records the bar ({ran}, {st['last_processed_bar']})")
check(len(sent) == 1 and "2361" in sent[0] and "UNIVERSE" in sent[0] and st["dead_noticed"] == ["2361"],
      f"(5) the dead member is named once ({sent})")
frame["df"] = pd.concat([close, pd.DataFrame({"2330": [1.0], "2317": [1.0]}, index=[pd.Timestamp("2026-10-19")])])
clock["now"] = datetime(2026, 10, 20, 9, 0)
with contextlib.redirect_stdout(io.StringIO()):
    wfb._tick("demo")
st = json.load(open("state/bar_wait/demo.json"))
check(st["last_processed_bar"] == "2026-10-19T00:00:00" and len(sent) == 1,
      f"(5) next bar: recorded, no second notice ({st['last_processed_bar']}, {len(sent)})")

# ── (6) the backtest warning ─────────────────────────────────────────────────
w = runner._dead_member_warnings(close, "1d")
check(len(w) == 1 and "2361 (last 2015-12-25)" in w[0], f"(6) backtest warns on the dead member ({w})")
check(runner._dead_member_warnings(close.drop(columns="2361"), "1d") == [], "(6) …and not without one")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
