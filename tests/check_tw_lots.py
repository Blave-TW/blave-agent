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
import contextlib
import io
import json
import os
import sys
import tempfile
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


os.chdir(WS)
runner._REPO_ROOT = WS
# the lookup runs in a child process (lib/runner._tw_fetch_child): the fakes live in a module
# the child imports from the workspace root, prices and calls go through files
(WS / "twfake.py").write_text('''
import json, time
import pandas as pd
DAYS = ["2026-10-15", "2026-10-16", "2026-10-17"]


def _log(codes):
    with open("calls.log", "a") as f:
        f.write(json.dumps(sorted(codes)) + "\\n")


def batch(codes, start, end, hdrs):
    _log(codes)
    raw = json.load(open("raw.json"))
    return {c: pd.DataFrame({"Close": [raw[c] - 5, raw[c], raw[c] + 77]}, index=pd.to_datetime(DAYS))
            for c in codes if c in raw}


def tz(codes, start, end, hdrs):
    idx = pd.DatetimeIndex(["2026-10-15", "2026-10-16"]).tz_localize("Asia/Taipei")
    return {c: pd.DataFrame({"Close": [990.0, 995.0]}, index=idx) for c in codes}


def lag(codes, start, end, hdrs):
    return {c: pd.DataFrame({"Close": [1000.0]}, index=pd.to_datetime(["2026-10-15"])) for c in codes}


def boom(*a):
    raise RuntimeError("feed down")


def pool(codes, start, end, hdrs):
    # what lib.data does: a thread pool, here with a worker still busy — joined at interpreter exit
    from concurrent.futures import ThreadPoolExecutor
    ThreadPoolExecutor(1).submit(time.sleep, 60)
    return batch(codes, start, end, hdrs)


def hang(*a):
    time.sleep(60)
    return {}
''')
RAW = {"2330": 1000.0, "2454": 1250.0}


def set_raw():
    (WS / "raw.json").write_text(json.dumps(RAW))


def calls():
    p = WS / "calls.log"
    out = [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []
    p.unlink(missing_ok=True)
    return out


set_raw()
runner.TW_CLOSE_FETCH = "twfake:batch"


def tc(prev, tg, day="2026-10-16", fn="twfake:batch"):
    runner.TW_CLOSE_FETCH = fn
    try:
        fields, need = runner.tw_carry_closes(prev, tg, day)
        more = runner.tw_fetch_closes(fields, need, {}, budget_s=30) if need else None
    finally:
        runner.TW_CLOSE_FETCH = "twfake:batch"
    return more if more is not None else fields


# ── priced on change, carried while it holds ──────────────────────────────────
first = tc({}, {"2330": 0.5, "2454": 0.5, "BTCUSDT": 0.0})
check(first == {"raw_closes": {"2330": 1000.0, "2454": 1250.0},
                "raw_close_dates": {"2330": "2026-10-16", "2454": "2026-10-16"}},
      f"first tick: each Taiwan target at the raw close of the round's own day, never the day after ({first})")
prev = dict({"weights": {"2330": 0.5, "2454": 0.5}}, **first)
RAW["2330"] = 1100.0
set_raw()
calls()
same = tc(prev, {"2330": 0.5, "2454": 0.5})
check(same["raw_closes"]["2330"] == 1000.0 and not calls(), "target unchanged: the old close is carried, nothing fetched")
moved = tc(prev, {"2330": 0.4, "2454": 0.5})
mc = calls()
check(moved["raw_closes"] == {"2330": 1100.0, "2454": 1250.0} and mc == [["2330"]],
      f"one weight changed: only that symbol re-priced ({moved['raw_closes']}, {mc})")
old = tc({"weights": {"2330": 0.5}}, {"2330": 0.5})
check(old.get("raw_closes_est") == ["2330"] and old["raw_closes"]["2330"] == 1100.0 and "raw_close_want" not in old,
      "pre-field state (same target, no close): latest close, an estimate for good")
check(tc({"weights": {"2330": 0.5}}, {"2330": 0.5, "1101": 0.5}).get("raw_closes") == {"2330": 1100.0},
      "a symbol the fetch has no bar for is left out (retried next tick)")
check(tc({}, {"BTCUSDT": 1.0}) == {}, "no Taiwan target: no fields at all")
check(tc({"symbol": "2330", "position": 1.0, "raw_closes": {"2330": 900.0},
          "raw_close_dates": {"2330": "2026-10-01"}}, {"2330": 1.0})["raw_closes"]["2330"] == 900.0,
      "Type A state: same position carries its close")
check(tc({}, {"2330": 1.0}, fn="twfake:tz").get("raw_closes") == {"2330": 995.0},
      "a tz-aware daily frame is read too (not silently skipped every tick)")
check(runner._taipei_date(pd.Timestamp("2026-10-15 16:00", tz="UTC")) == "2026-10-16"
      and runner._taipei_date(pd.Timestamp("2026-10-16")) == "2026-10-16",
      "bar label → Taipei trading date (16:00 UTC the day before / UTC midnight)")

# ── the round's close not in yet: an estimate, retried until it arrives ───────
p1 = tc({}, {"2330": 1.0}, fn="twfake:lag")
check(p1.get("raw_close_dates") == {"2330": "2026-10-15"} and p1.get("raw_closes_est") == ["2330"]
      and p1.get("raw_close_want") == {"2330": "2026-10-16"},
      f"only the day before is in: recorded as an estimate, the round's date kept to ask again ({p1})")
st1 = dict({"weights": {"2330": 1.0}}, **p1)
calls()
p2 = tc(st1, {"2330": 1.0}, day="2026-10-19")
pc = calls()
check(pc == [["2330"]] and p2["raw_closes"]["2330"] == RAW["2330"] and p2["raw_close_dates"]["2330"] == "2026-10-16"
      and "raw_closes_est" not in p2 and "raw_close_want" not in p2,
      f"next tick: asked again for the round's day (not today's), settled, estimate dropped ({p2})")
tc(dict({"weights": {"2330": 1.0}}, **p2), {"2330": 1.0}, day="2026-10-20")
check(not calls(), "…then carried, no more lookups")
stale = runner.tw_carry_closes(dict(st1), {"2330": 1.0}, "2026-10-30")
check(stale[1] == {} and stale[0].get("raw_closes_est") == ["2330"],
      "still short after TW_CLOSE_WANT_DAYS: kept as an estimate, no more retries")

# ── never costs the tick its state ────────────────────────────────────────────
t0 = time.monotonic()
runner.TW_CLOSE_FETCH = "twfake:pool"
try:
    pp = runner.tw_fetch_closes({}, {"2330": ("2026-10-16", False)}, {})
finally:
    runner.TW_CLOSE_FETCH = "twfake:batch"
check(pp and pp["raw_closes"] == {"2330": 1100.0} and time.monotonic() - t0 < runner.TW_CLOSE_BUDGET_S,
      f"a lookup whose thread pool is still busy hands its answer back without waiting for the pool ({time.monotonic() - t0:.2f}s)")
check(tc({}, {"2330": 1.0}, fn="twfake:boom") == {}, "fetch failure: nothing recorded, no exception")
check(tc({}, {"2330": 1.0}, fn="twfake_gone:batch") == {}, "lookup module fails to import: nothing recorded, no exception")
import subprocess  # noqa: E402
spawned, RealPopen = [], subprocess.Popen


class SpyPopen(RealPopen):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        spawned.append(self)


runner.TW_CLOSE_FETCH, subprocess.Popen = "twfake:hang", SpyPopen
t0 = time.monotonic()
try:
    r = runner.tw_fetch_closes({}, {"2330": ("2026-10-16", False)}, {"api-key": "SENTINELKEY", "secret-key": "SENTINELSEC"},
                               budget_s=2)
finally:
    runner.TW_CLOSE_FETCH, subprocess.Popen = "twfake:batch", RealPopen
el = time.monotonic() - t0
check(r is None and el < 4 and len(spawned) == 1 and spawned[0].poll() is not None,
      f"a hung lookup is killed at the budget — that child, and it is gone ({el:.2f}s)")
argv = " ".join(map(str, spawned[0].args)) if spawned else ""
check(spawned and "SENTINEL" not in argv, "the data keys reach the child over stdin, never on its command line")

# the strategy process killed mid-lookup (wait_for_bar's timeout): the child ends itself just past the budget
orphan = subprocess.Popen([sys.executable, "-E", "-c", runner._TW_CLOSE_CHILD], stdin=subprocess.PIPE,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=str(WS))
orphan.stdin.write(json.dumps({"groups": {"2026-10-16": ["2330"]}, "hdrs": {}, "fn": "twfake:hang", "budget_s": 1,
                               "paths": [ROOT]}).encode())
orphan.stdin.close()
try:
    orphan.wait(timeout=8)
    gone = True
except subprocess.TimeoutExpired:
    orphan.kill()
    orphan.wait()
    gone = False
check(gone, "no parent reading it: a hung lookup child exits on its own timer (no 13-minute orphan)")

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
    stamps.append((name, "raw_closes" in st, os.stat(WS / "strategies" / name / "state.json").st_mtime_ns,
                   {k: v for k, v in st.items() if not k.startswith("raw_")}))


runner.save_state = spy_save
try:
    live(tick_c)
finally:
    runner.save_state = real_save
check([s[1] for s in stamps] == [False, True] and [s[3] for s in stamps][0] == [s[3] for s in stamps][1],
      f"position saved first, close added by a second write with the very same target ({[s[:2] for s in stamps]})")
live(tick_a)
sc, sa = read("pfc"), read("pfa")
check(sc.get("raw_closes") == {"2330": 1100.0, "2454": 1250.0} and sc.get("raw_close_dates", {}).get("2330") == "2026-10-16",
      f"Type C live tick: raw closes in state.json, not the strategy's own series ({sc.get('raw_closes')})")
check(sa.get("raw_closes") == {"2454": 1250.0}, f"Type A live tick: raw close in state.json ({sa.get('raw_closes')})")
live(lambda: tick_a(0.0))
check(read("pfa").get("position") == 0 and "raw_closes" not in read("pfa"),
      "Type A goes flat: the old close does not linger in state.json")

# lookup import fails / hangs: the target position is still saved this tick
runner.TW_CLOSE_FETCH = "twfake_gone:batch"
try:
    live(lambda: tick_c(0.25))
    live(lambda: tick_a(1.0))
finally:
    runner.TW_CLOSE_FETCH = "twfake:batch"
sc, sa = read("pfc"), read("pfa")
check(sc["weights"] == {"2330": 0.25, "2454": 0.25} and "raw_closes" not in sc and sa["position"] == 1.0,
      f"import of the price lookup fails: the new target is saved anyway, just without a close ({sc['weights']})")
runner.TW_CLOSE_FETCH, runner.TW_CLOSE_BUDGET_S, keep = "twfake:hang", 1, runner.TW_CLOSE_BUDGET_S
t0 = time.monotonic()
try:
    live(lambda: tick_c(0.4))
finally:
    runner.TW_CLOSE_FETCH, runner.TW_CLOSE_BUDGET_S = "twfake:batch", keep
el = time.monotonic() - t0
check(read("pfc")["weights"]["2330"] == 0.4 and el < 5,
      f"price lookup hangs: the new target is saved, the tick bounded ({el:.2f}s)")

# the whole strategy process, as wait_for_bar runs it: a lookup stuck 60 s costs ≤ the budget
STRAT = WS / "strategies" / "pfp"
STRAT.mkdir(parents=True, exist_ok=True)
(STRAT / "strategy.py").write_text('INTERVAL = "1d"\nMARKET = "spot"\n')
probe = f"""
import os, sys, time
t_import = time.monotonic()
sys.path[:0] = [{ROOT!r}, {os.path.join(ROOT, "runtime")!r}]
os.environ["MPLBACKEND"] = "Agg"
import dotenv; dotenv.dotenv_values = lambda *a, **k: {{}}
import numpy as np, pandas as pd
import lib.runner as runner
runner.dotenv_values = lambda *a, **k: {{}}
runner._REPO_ROOT = __import__("pathlib").Path(os.getcwd())
runner.TW_CLOSE_FETCH = "twfake:hang"
idx = pd.bdate_range("2026-06-01", "2026-10-16")
c = pd.DataFrame({{"2330": np.linspace(900, 1300, len(idx))}}, index=idx)
print("TICK", time.monotonic(), flush=True)
os.environ["BLAVE_MODE"] = "live"
runner.run({{"STRATEGY_NAME": "pfp", "INTERVAL": "1d", "START": "2026-06-01", "FEE": 0.003, "MARKET": "spot",
            "__file__": os.path.abspath("strategies/pfp/strategy.py")}}, lambda h: (c.copy(), c.copy()),
           lambda d: (np.full((len(d[0]), 1), 0.5), pd.concat({{"close": d[0], "open": d[1]}}, axis=1)))
"""
proc = subprocess.Popen([sys.executable, "-c", probe], cwd=str(WS), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        env=dict(os.environ, BLAVE_MODE="live"))
try:
    out, _ = proc.communicate(timeout=90)
except subprocess.TimeoutExpired:
    proc.kill()
    out, _ = proc.communicate()
end = time.monotonic()
tick_at = [float(x.split()[1]) for x in out.decode().splitlines() if x.startswith("TICK ")]
spent = end - tick_at[0] if tick_at else None
pst = json.loads((STRAT / "state.json").read_text()) if (STRAT / "state.json").exists() else {}
check(proc.returncode == 0 and spent is not None and spent <= 12 and pst.get("weights", {}).get("2330") == 0.5,
      f"strategy process with a lookup stuck 60 s: target saved, process out {spent and round(spent, 2)} s after the tick began (≤ 12)")

# another writer saved a newer target while the lookup ran: the older one is never written back
real_fetch = runner.tw_fetch_closes


def racing(fields, need, hdrs, budget_s=None, **k):
    time.sleep(0.01)
    runner.save_state("pfc", {"type": "portfolio", "market": "spot", "weights": {"2330": 0.9, "2454": 0.1}})
    return real_fetch(fields, need, hdrs, budget_s, **k)


runner.tw_fetch_closes = racing
try:
    live(lambda: tick_c(0.3))
finally:
    runner.tw_fetch_closes = real_fetch
check(read("pfc")["weights"] == {"2330": 0.9, "2454": 0.1},
      f"race: a hand-run tick's newer target survives the lookup's second write ({read('pfc')['weights']})")

# the second write itself raises: the tick still ends normally, the saved target stays
n_save = []


def flaky(name, st):
    n_save.append(1)
    if len(n_save) >= 2:
        raise OSError("disk full")
    real_save(name, st)


runner.save_state = flaky
try:
    live(lambda: tick_c(0.35))
    ok_end = True
except Exception:
    ok_end = False
finally:
    runner.save_state = real_save
check(ok_end and len(n_save) == 2 and read("pfc")["weights"]["2330"] == 0.35,
      "second write raises: the tick ends normally, the first save's target stays")

# ── reporter: forwarded per state, summed into whole lots ─────────────────────
import portfolio_reporter as pr  # noqa: E402

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
check(lots["2330@spot"]["odd_shares"] == 105 and lots["2330@spot"]["shares"] == 2105,
      "the odd lot is reported (odd_shares 105): placed by hand as a whole-lot + an odd-lot order")
check(lots["2454@spot"]["lots"] == 1 and lots["2454@spot"]["odd_shares"] == 684, "2,105,000 at 1250 = 1684 shares → 1 lot + 684")
u = pr.tw_lots({"amounts": {"c": 1_500_000}}, S)["2330@spot"]
check(u["lots"] == 0 and u["odd_shares"] == 750, f"750,000 TWD at 1000 = 750 shares → 0 lots + 750 odd ({u})")
x = pr.tw_lots({"amounts": {"c": 4_000_000}}, S)["2330@spot"]
check(x["lots"] == 2 and x["odd_shares"] == 0, f"exactly 2,000 shares → 2 lots, odd 0 ({x})")
z = pr.tw_lots({"amounts": {"c": 1_000}}, S)["2330@spot"]
check(z["lots"] == 0 and z["odd_shares"] == 0 and z["shares"] == 0, f"under one share → 0 / 0 ({z})")
two = pr.tw_lots({"amounts": {"c": 2_000_000, "a": 1_200_000}}, S)["2330@spot"]
check(two["lots"] == 2 and two["est"] is True and two["price_date"] == "2026-10-16",
      f"two strategies: each at its own close (1000 + 1500 shares → 2 lots), est carried, newest date ({two})")
check("2454@spot" not in pr.tw_lots({"amounts": {"n": 1_000_000}}, S),
      "a contributor without a close: no row (the page keeps TWD)")
neg = pr.tw_lots({"amounts": {"a": 2_000_000}}, dict(S, a=dict(S["a"], position=-1.0)))["2330@spot"]
check(neg["lots"] == 0 and neg["odd_shares"] == 0 and neg["twd"] == 0, "spot row below 0 is 0 lots")
sp = pr.tw_lots({"amounts": {"s": 2_000_000, "a": 1_600_000}}, S)["2330@spot"]
check(sp["twd"] == 1_600_000 and sp["lots"] == 2,
      f"spot Type C negative weight counts as 0: only the long strategy sizes the row ({sp})")

# paper (config.exchanges[name] == "paper"): every TW leg is cash shares whatever MARKET says,
# each strategy's own short counts as 0 before summing, and the row is whole shares (paper e2e B1)
P = {"tw_a": {"market": "swap", "symbol": "2330", "position": 1.0, "raw_closes": {"2330": 2420.0},
              "raw_close_dates": {"2330": "2026-10-16"}},
     "tw_c": {"market": "spot", "weights": {"2330": 0.4}, "raw_closes": {"2330": 2420.0},
              "raw_close_dates": {"2330": "2026-10-16"}}}
PX = {"tw_a": "paper", "tw_c": "paper"}
pp = pr.tw_lots({"amounts": {"tw_a": 2_100_000, "tw_c": 1_000_000}, "exchanges": PX}, P)
check(set(pp) == {"2330@spot"} and pp["2330@spot"]["twd"] == 2_500_000
      and pp["2330@spot"]["shares"] == 1033 and pp["2330@spot"]["lots"] == 1
      and pp["2330@spot"]["unit"] == "shares",
      f"paper: a swap Type A folds into SYM@spot, 2,500,000 at 2420 = 1033 shares, no bare SYM row ({pp})")
pn = pr.tw_lots({"amounts": {"tw_a": 3_000_000, "tw_c": 1_000_000}, "exchanges": PX},
                dict(P, tw_a=dict(P["tw_a"], position=-1.0)))
check(set(pn) == {"2330@spot"} and pn["2330@spot"]["twd"] == 400_000 and pn["2330@spot"]["shares"] == 165,
      f"paper: the swap Type A short counts as 0, the Type C long is kept (400,000 at 2420 = 165 shares) ({pn})")
pl = pr.tw_lots({"amounts": {"tw_a": 2_100_000}}, P)
check(set(pl) == {"2330"} and pl["2330"]["unit"] == "lots",
      f"no exchange (not paper): the swap Type A keeps its own row in whole lots ({pl})")
pm = pr.tw_lots({"amounts": {"tw_c": 1_000_000, "a": 1_600_000}, "exchanges": {"tw_c": "paper"}},
                dict(P, a=S["a"]))
check(pm["2330@spot"]["unit"] == "lots",
      f"a row with any non-paper contributor stays in lots ({pm})")

# unrouted (config.exchanges[name] == "": unbound, not saved since): the reconciler skips it
# (lib/portfolio.aggregate_portfolio), so the row does not count it (audit v027-integ2 P3-1)
VB = {"paper": {"credentials": True, "pair": True, "order": True, "account": True}}
pu = pr.tw_lots({"amounts": {"tw_a": 2_100_000, "tw_c": 1_000_000},
                 "exchanges": {"tw_a": "", "tw_c": "paper"}}, P, VB)
check(set(pu) == {"2330@spot"} and pu["2330@spot"]["twd"] == 400_000
      and pu["2330@spot"]["unit"] == "shares",
      f"a venue bound: an unrouted strategy is not a contributor; only the paper Type C sizes the row ({pu})")
# nothing bound (signal-only, report venues {}): runtime had no venue to inherit, every route is "";
# those are signal positions, not unrouted — sized in whole lots (v027-integ2 regression: was {})
nc = pr.tw_lots({"amounts": {"tw_c": 1_000_000}, "exchanges": {"tw_c": ""}}, P, {})
check(nc.get("2330@spot", {}).get("twd") == 400_000 and nc["2330@spot"]["lots"] == 0
      and nc["2330@spot"]["shares"] == 165 and nc["2330@spot"]["unit"] == "lots",
      f"no venue bound: a Type C routed \"\" is sized (400,000 at 2420 = 165 shares, 0 lots, unit lots) ({nc})")
na = pr.tw_lots({"amounts": {"tw_a": 5_000_000}, "exchanges": {"tw_a": ""}}, P, {})
check(na.get("2330", {}).get("lots") == 2 and na["2330"]["unit"] == "lots",
      f"no venue bound: a Type A routed \"\" is sized (5,000,000 at 2420 = 2 lots) ({na})")
half = {"binance": {"credentials": True, "pair": True, "order": False, "account": True}}
check(pr.tw_lots({"amounts": {"tw_a": 5_000_000}, "exchanges": {"tw_a": ""}}, P, half).get("2330", {}).get("lots") == 2,
      "a venue without its order lib is not bound (same as the desktop's trVenueIds): still signal-only")
check(pr.tw_lots({"amounts": {"tw_a": 5_000_000}, "exchanges": {"tw_a": ""}}, P,
                 {"binance": dict(half["binance"], order=True)}) == {},
      "one venue bound, this strategy routed \"\": not a contributor")
check('"tw_lots": tw_lots(cfg, states, vens)' in open(pr.__file__).read(),
      "the report passes the bound venues into tw_lots")
check(pr.tw_lots({"amounts": {"tw_a": 2_100_000}}, P).get("2330", {}).get("twd") == 2_100_000,
      "no exchanges entry at all: counted as before (non-paper)")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
