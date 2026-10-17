"""Minimal check: Taiwan-stock rows of 「各商品的總訊號部位」 in whole lots (0.1.27).

lib/runner.tw_target_closes prices each Taiwan-stock target once, with the unadjusted close of
the tick its target changed, and carries it while the target holds (a daily re-price would ask
for a few shares every day); a state from before the field is priced at the latest close and
marked closes_est. runtime/portfolio_reporter forwards the closes per state and sums each row
into whole lots (tw_lots: floor, odd lots dropped, under one lot = 0, a contributor without a
close = no row). The live ticks of Type A and Type C both write it.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_lots.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="tw-lots-", dir=os.environ.get("SCRATCHPAD") or None))
os.environ["BLAVE_AGENT_WORKSPACE"] = str(WS)
os.environ["BLAVE_AGENT_BASE"] = str(WS)
os.environ.setdefault("MPLBACKEND", "Agg")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.data as data
import lib.runner as runner

runner.dotenv_values = lambda *a, **k: {}

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


calls = []
RAW = {"2330": 1000.0, "2454": 1250.0}


def fake_batch(codes, start, end, hdrs):
    calls.append(list(codes))
    idx = pd.to_datetime(["2026-10-15", "2026-10-16"])
    return {c: pd.DataFrame({"Close": [RAW[c] - 5, RAW[c]]}, index=idx) for c in codes if c in RAW}


tc = lambda prev, tg: runner.tw_target_closes(prev, tg, "2026-10-16", {}, fetch=fake_batch)

# ── lib: priced on change, carried while it holds ─────────────────────────────
first = tc({}, {"2330": 0.5, "2454": 0.5, "BTCUSDT": 0.0})
check(first == {"closes": {"2330": 1000.0, "2454": 1250.0},
                "close_dates": {"2330": "2026-10-16", "2454": "2026-10-16"}},
      f"first tick: each Taiwan target priced at the raw close ({first})")
prev = dict({"weights": {"2330": 0.5, "2454": 0.5}}, **first)
RAW["2330"] = 1100.0
calls.clear()
same = tc(prev, {"2330": 0.5, "2454": 0.5})
check(same["closes"]["2330"] == 1000.0 and not calls,
      "target unchanged: the old close is carried, nothing re-fetched")
moved = tc(prev, {"2330": 0.4, "2454": 0.5})
check(moved["closes"] == {"2330": 1100.0, "2454": 1250.0} and calls == [["2330"]],
      f"one weight changed: only that symbol re-priced ({moved['closes']}, {calls})")
old = tc({"weights": {"2330": 0.5}}, {"2330": 0.5})
check(old.get("closes_est") == ["2330"] and old["closes"]["2330"] == 1100.0,
      "pre-field state (same target, no close): latest close, marked closes_est")
check(tc({"weights": {"2330": 0.5}}, {"2330": 0.5, "1101": 0.5}).get("closes") == {"2330": 1100.0},
      "a symbol the fetch has no bar for is left out (retried next tick)")


def tz_batch(codes, start, end, hdrs):
    idx = pd.DatetimeIndex(["2026-10-15", "2026-10-16"]).tz_localize("Asia/Taipei")
    return {c: pd.DataFrame({"Close": [990.0, 995.0]}, index=idx) for c in codes}


check(runner.tw_target_closes({}, {"2330": 1.0}, "2026-10-16", {}, fetch=tz_batch).get("closes") == {"2330": 995.0},
      "a tz-aware daily frame is read too (not silently skipped every tick)")


def boom(*a):
    raise RuntimeError("feed down")


check(runner.tw_target_closes({}, {"2330": 1.0}, "2026-10-16", {}, fetch=boom) == {},
      "fetch failure: nothing recorded, no exception")
check(tc({}, {"BTCUSDT": 1.0}) == {}, "no Taiwan target: no fields at all")
check(tc({"symbol": "2330", "position": 1.0, "closes": {"2330": 900.0},
          "close_dates": {"2330": "2026-10-01"}}, {"2330": 1.0})["closes"]["2330"] == 900.0,
      "Type A state: same position carries its close")

# ── live ticks write it ────────────────────────────────────────────────────────
data.fetch_twstock_price_batch = fake_batch
os.chdir(WS)
runner._REPO_ROOT = WS
IDX = pd.bdate_range("2026-06-01", "2026-10-16")
CLOSE = pd.DataFrame({"2330": np.linspace(900, 1300, len(IDX)), "2454": np.linspace(1000, 1400, len(IDX))},
                     index=IDX)
for name, src in (("pfc", 'INTERVAL = "1d"\nMARKET = "spot"\n'), ("pfa", 'INTERVAL = "1d"\nMARKET = "spot"\n')):
    (WS / "strategies" / name).mkdir(parents=True, exist_ok=True)
    (WS / "strategies" / name / "strategy.py").write_text(src)
os.environ["BLAVE_MODE"] = "live"
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run({"STRATEGY_NAME": "pfc", "INTERVAL": "1d", "START": "2026-06-01", "FEE": 0.003,
                    "MARKET": "spot", "__file__": str(WS / "strategies/pfc/strategy.py")},
                   lambda h: (CLOSE.copy(), CLOSE.copy()),
                   lambda d: (np.full((len(d[0]), 2), 0.5), pd.concat({"close": d[0], "open": d[1]}, axis=1)))
        runner.run({"STRATEGY_NAME": "pfa", "SYMBOL": "2454", "INTERVAL": "1d", "START": "2026-06-01",
                    "FEE": 0.003, "MARKET": "spot", "__file__": str(WS / "strategies/pfa/strategy.py")},
                   lambda h: pd.DataFrame({"Open": CLOSE["2454"], "High": CLOSE["2454"], "Low": CLOSE["2454"],
                                           "Close": CLOSE["2454"], "Volume": 1.0}),
                   lambda df: pd.Series(1.0, index=df.index))
finally:
    os.environ["BLAVE_MODE"] = "backtest"
sc = json.loads((WS / "strategies/pfc/state.json").read_text())
sa = json.loads((WS / "strategies/pfa/state.json").read_text())
check(sc.get("closes") == {"2330": 1100.0, "2454": 1250.0} and sc.get("close_dates", {}).get("2330") == "2026-10-16",
      f"Type C live tick: raw closes in state.json, not the strategy's own series ({sc.get('closes')})")
check(sa.get("closes") == {"2454": 1250.0}, f"Type A live tick: raw close in state.json ({sa.get('closes')})")

# ── reporter: forwarded per state, summed into whole lots ─────────────────────
import portfolio_reporter as pr  # noqa: E402

st = pr.strategy_states()
check(st["pfc"].get("closes") == {"2330": 1100.0, "2454": 1250.0} and st["pfa"].get("close_dates") == {"2454": "2026-10-16"},
      "strategy_states forwards closes / close_dates")
S = {"c": {"market": "spot", "weights": {"2330": 0.5, "2454": 0.5}, "closes": {"2330": 1000.0, "2454": 1250.0},
           "close_dates": {"2330": "2026-10-16", "2454": "2026-10-16"}},
     "a": {"market": "spot", "symbol": "2330", "position": 1.0, "closes": {"2330": 800.0},
           "close_dates": {"2330": "2026-10-01"}, "closes_est": ["2330"]},
     "n": {"market": "spot", "weights": {"2454": 1.0}}}
lots = pr.tw_lots({"amounts": {"c": 4_210_000, "a": 0}}, S)
check(lots["2330@spot"]["lots"] == 2 and lots["2330@spot"]["twd"] == 2_105_000,
      f"2,105,000 TWD at 1000 = 2105 shares → 2 lots, odd 105 dropped ({lots.get('2330@spot')})")
check(lots["2454@spot"]["lots"] == 1, "2,105,000 at 1250 = 1684 shares → 1 lot")
check(pr.tw_lots({"amounts": {"c": 1_500_000}}, S)["2330@spot"]["lots"] == 0,
      "750,000 TWD at 1000 = 750 shares → 0 lots (cannot afford one)")
two = pr.tw_lots({"amounts": {"c": 2_000_000, "a": 1_200_000}}, S)["2330@spot"]
check(two["lots"] == 2 and two["est"] is True and two["price_date"] == "2026-10-16",
      f"two strategies: each at its own close (1000 + 1500 shares → 2 lots), est carried, newest date ({two})")
check("2454@spot" not in pr.tw_lots({"amounts": {"n": 1_000_000}}, S),
      "a contributor without a close: no row (the page keeps TWD)")
neg = pr.tw_lots({"amounts": {"a": 2_000_000}}, dict(S, a=dict(S["a"], position=-1.0)))["2330@spot"]
check(neg["lots"] == 0 and neg["twd"] == 0, "spot row below 0 is 0 lots")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
