"""Minimal check: Taiwan-stock rows of 「各商品的總訊號部位」 in whole lots (0.1.27).

lib/runner prices each Taiwan-stock target once, with the unadjusted close of the round its
target changed, and carries it while the target holds (a daily re-price would ask for a few
shares every day). A close dated before its round (that day's bar not in yet) is an estimate,
retried each tick until the round's own close arrives. A state from before the field is priced
at the latest close and stays an estimate. The live tick saves the target position FIRST and
prices afterwards under a time budget: a failing, slow or missing price lookup never costs the
tick its state. runtime/portfolio_reporter forwards raw_closes per state and sums each row into
whole lots (tw_lots: floor, odd lots dropped, under one lot = 0, a contributor without a close =
no row).

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_tw_lots.py
"""
import builtins
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
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
DAYS = ["2026-10-15", "2026-10-16", "2026-10-17"]


def fake_batch(codes, start, end, hdrs):
    """Daily raw bars through 10-17 (one day past the round), cut at `end` by the caller."""
    calls.append(list(codes))
    idx = pd.to_datetime(DAYS)
    return {c: pd.DataFrame({"Close": [RAW[c] - 5, RAW[c], RAW[c] + 77]}, index=idx) for c in codes if c in RAW}


def tc(prev, tg, day="2026-10-16", fetch=fake_batch):
    fields, need = runner.tw_carry_closes(prev, tg, day)
    more = runner.tw_fetch_closes(fields, need, {}, fetch=fetch, budget_s=5) if need else None
    return more if more is not None else fields


# ── priced on change, carried while it holds ──────────────────────────────────
first = tc({}, {"2330": 0.5, "2454": 0.5, "BTCUSDT": 0.0})
check(first == {"raw_closes": {"2330": 1000.0, "2454": 1250.0},
                "raw_close_dates": {"2330": "2026-10-16", "2454": "2026-10-16"}},
      f"first tick: each Taiwan target at the raw close of the round's own day, never the day after ({first})")
prev = dict({"weights": {"2330": 0.5, "2454": 0.5}}, **first)
RAW["2330"] = 1100.0
calls.clear()
same = tc(prev, {"2330": 0.5, "2454": 0.5})
check(same["raw_closes"]["2330"] == 1000.0 and not calls, "target unchanged: the old close is carried, nothing fetched")
moved = tc(prev, {"2330": 0.4, "2454": 0.5})
check(moved["raw_closes"] == {"2330": 1100.0, "2454": 1250.0} and calls == [["2330"]],
      f"one weight changed: only that symbol re-priced ({moved['raw_closes']}, {calls})")
old = tc({"weights": {"2330": 0.5}}, {"2330": 0.5})
check(old.get("raw_closes_est") == ["2330"] and old["raw_closes"]["2330"] == 1100.0 and "raw_close_want" not in old,
      "pre-field state (same target, no close): latest close, an estimate for good")
check(tc({"weights": {"2330": 0.5}}, {"2330": 0.5, "1101": 0.5}).get("raw_closes") == {"2330": 1100.0},
      "a symbol the fetch has no bar for is left out (retried next tick)")
check(tc({}, {"BTCUSDT": 1.0}) == {}, "no Taiwan target: no fields at all")
check(tc({"symbol": "2330", "position": 1.0, "raw_closes": {"2330": 900.0},
          "raw_close_dates": {"2330": "2026-10-01"}}, {"2330": 1.0})["raw_closes"]["2330"] == 900.0,
      "Type A state: same position carries its close")


def tz_batch(codes, start, end, hdrs):
    idx = pd.DatetimeIndex(["2026-10-15", "2026-10-16"]).tz_localize("Asia/Taipei")
    return {c: pd.DataFrame({"Close": [990.0, 995.0]}, index=idx) for c in codes}


check(tc({}, {"2330": 1.0}, fetch=tz_batch).get("raw_closes") == {"2330": 995.0},
      "a tz-aware daily frame is read too (not silently skipped every tick)")
check(runner._taipei_date(pd.Timestamp("2026-10-15 16:00", tz="UTC")) == "2026-10-16"
      and runner._taipei_date(pd.Timestamp("2026-10-16")) == "2026-10-16",
      "bar label → Taipei trading date (16:00 UTC the day before / UTC midnight)")

# ── the round's close not in yet: an estimate, retried until it arrives ───────
lag = lambda codes, s, e, h: {c: pd.DataFrame({"Close": [1000.0]}, index=pd.to_datetime(["2026-10-15"])) for c in codes}
p1 = tc({}, {"2330": 1.0}, fetch=lag)
check(p1.get("raw_close_dates") == {"2330": "2026-10-15"} and p1.get("raw_closes_est") == ["2330"]
      and p1.get("raw_close_want") == {"2330": "2026-10-16"},
      f"only the day before is in: recorded as an estimate, the round's date kept to ask again ({p1})")
st1 = dict({"weights": {"2330": 1.0}}, **p1)
calls.clear()
p2 = tc(st1, {"2330": 1.0}, day="2026-10-19")
check(calls == [["2330"]] and p2["raw_closes"]["2330"] == RAW["2330"] and p2["raw_close_dates"]["2330"] == "2026-10-16"
      and "raw_closes_est" not in p2 and "raw_close_want" not in p2,
      f"next tick: asked again for the round's day (not today's), settled, estimate dropped ({p2})")
calls.clear()
tc(dict({"weights": {"2330": 1.0}}, **p2), {"2330": 1.0}, day="2026-10-20")
check(not calls, "…then carried, no more lookups")
stale = runner.tw_carry_closes(dict(st1), {"2330": 1.0}, "2026-10-30")
check(stale[1] == {} and stale[0].get("raw_closes_est") == ["2330"],
      "still short after TW_CLOSE_WANT_DAYS: kept as an estimate, no more retries")


# ── never costs the tick its state ────────────────────────────────────────────
def boom(*a):
    raise RuntimeError("feed down")


check(tc({}, {"2330": 1.0}, fetch=boom) == {}, "fetch failure: nothing recorded, no exception")
gate = threading.Event()
slow = lambda *a: gate.wait(30) or {}
t0 = time.monotonic()
r = runner.tw_fetch_closes({}, {"2330": ("2026-10-16", False)}, {}, fetch=slow, budget_s=0.5)
check(r is None and time.monotonic() - t0 < 2, f"a slow lookup is cut at the budget ({time.monotonic() - t0:.2f}s)")
calls.clear()
check(runner.tw_fetch_closes({}, {"2330": ("2026-10-16", False)}, {}, fetch=fake_batch, budget_s=0.5) is None
      and not calls, "…and the next tick does not stack a second one while it still runs")
gate.set()
time.sleep(0.2)

data.fetch_twstock_price_batch = fake_batch
os.chdir(WS)
runner._REPO_ROOT = WS
IDX = pd.bdate_range("2026-06-01", "2026-10-16")
CLOSE = pd.DataFrame({"2330": np.linspace(900, 1300, len(IDX)), "2454": np.linspace(1000, 1400, len(IDX))},
                     index=IDX)
for name in ("pfc", "pfa"):
    (WS / "strategies" / name).mkdir(parents=True, exist_ok=True)
    (WS / "strategies" / name / "strategy.py").write_text('INTERVAL = "1d"\nMARKET = "spot"\n')


def live(fn):
    os.environ["BLAVE_MODE"] = "live"
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fn()
    finally:
        os.environ["BLAVE_MODE"] = "backtest"


def tick_c(w=0.5):
    runner.run({"STRATEGY_NAME": "pfc", "INTERVAL": "1d", "START": "2026-06-01", "FEE": 0.003,
                "MARKET": "spot", "__file__": str(WS / "strategies/pfc/strategy.py")},
               lambda h: (CLOSE.copy(), CLOSE.copy()),
               lambda d: (np.full((len(d[0]), 2), w), pd.concat({"close": d[0], "open": d[1]}, axis=1)))


def tick_a(sig=1.0):
    runner.run({"STRATEGY_NAME": "pfa", "SYMBOL": "2454", "INTERVAL": "1d", "START": "2026-06-01",
                "FEE": 0.003, "MARKET": "spot", "__file__": str(WS / "strategies/pfa/strategy.py")},
               lambda h: pd.DataFrame({"Open": CLOSE["2454"], "High": CLOSE["2454"], "Low": CLOSE["2454"],
                                       "Close": CLOSE["2454"], "Volume": 1.0}),
               lambda df: pd.Series(sig, index=df.index))


read = lambda n: json.loads((WS / "strategies" / n / "state.json").read_text())
stamps = []
real_save = runner.save_state


def spy_save(name, st):
    real_save(name, st)
    stamps.append((name, "raw_closes" in st, os.stat(WS / "strategies" / name / "state.json").st_mtime_ns))


runner.save_state = spy_save
try:
    live(tick_c)
finally:
    runner.save_state = real_save
mt_c = os.stat(WS / "strategies/pfc/state.json").st_mtime_ns
check([s[1] for s in stamps] == [False, True] and mt_c == stamps[0][2],
      f"position saved first, close added by a second write that keeps the first mtime (no extra reconcile round) {stamps}")
live(tick_a)
sc, sa = read("pfc"), read("pfa")
check(sc.get("raw_closes") == {"2330": 1100.0, "2454": 1250.0} and sc.get("raw_close_dates", {}).get("2330") == "2026-10-16",
      f"Type C live tick: raw closes in state.json, not the strategy's own series ({sc.get('raw_closes')})")
check(sa.get("raw_closes") == {"2454": 1250.0}, f"Type A live tick: raw close in state.json ({sa.get('raw_closes')})")
live(lambda: tick_a(0.0))
check(read("pfa").get("position") == 0 and "raw_closes" not in read("pfa"),
      "Type A goes flat: the old close does not linger in state.json")

# lookup import fails / times out: the target position is still saved this tick
real_import = builtins.__import__


def no_data(name, *a, **k):
    if name == "lib.data" and a and a[2] and "fetch_twstock_price_batch" in a[2]:
        raise ImportError("half-updated workspace")
    return real_import(name, *a, **k)


builtins.__import__ = no_data
try:
    live(lambda: tick_c(0.25))
    live(lambda: tick_a(1.0))
finally:
    builtins.__import__ = real_import
sc, sa = read("pfc"), read("pfa")
check(sc["weights"] == {"2330": 0.25, "2454": 0.25} and "raw_closes" not in sc and sa["position"] == 1.0,
      f"import of the price lookup fails: the new target is saved anyway, just without a close ({sc['weights']})")
gate2 = threading.Event()
data.fetch_twstock_price_batch = lambda *a: gate2.wait(30) or {}
runner.TW_CLOSE_BUDGET_S, keep = 0.5, runner.TW_CLOSE_BUDGET_S
t0 = time.monotonic()
try:
    live(lambda: tick_c(0.4))
finally:
    runner.TW_CLOSE_BUDGET_S = keep
    gate2.set()
check(read("pfc")["weights"]["2330"] == 0.4 and time.monotonic() - t0 < 10,
      f"price lookup hangs: the new target is saved, the tick bounded ({time.monotonic() - t0:.2f}s)")
time.sleep(0.2)

# ── reporter: forwarded per state, summed into whole lots ─────────────────────
import portfolio_reporter as pr  # noqa: E402

data.fetch_twstock_price_batch = fake_batch
live(lambda: tick_c(0.5))
live(lambda: tick_a(1.0))
st = pr.strategy_states()
check(st["pfc"].get("raw_closes") == {"2330": 1100.0, "2454": 1250.0} and st["pfa"].get("raw_close_dates") == {"2454": "2026-10-16"},
      "strategy_states forwards raw_closes / raw_close_dates")
S = {"c": {"market": "spot", "weights": {"2330": 0.5, "2454": 0.5}, "raw_closes": {"2330": 1000.0, "2454": 1250.0},
           "raw_close_dates": {"2330": "2026-10-16", "2454": "2026-10-16"}},
     "a": {"market": "spot", "symbol": "2330", "position": 1.0, "raw_closes": {"2330": 800.0},
           "raw_close_dates": {"2330": "2026-10-01"}, "raw_closes_est": ["2330"]},
     "n": {"market": "spot", "weights": {"2454": 1.0}},
     "s": {"market": "spot", "weights": {"2330": -0.5}, "raw_closes": {"2330": 1000.0},
           "raw_close_dates": {"2330": "2026-10-16"}}}
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
sp = pr.tw_lots({"amounts": {"s": 2_000_000, "a": 1_600_000}}, S)["2330@spot"]
check(sp["twd"] == 1_600_000 and sp["lots"] == 2,
      f"spot Type C negative weight counts as 0: only the long strategy sizes the row ({sp})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
