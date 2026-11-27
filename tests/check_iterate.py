"""lib/iterate.py — the auto-iterate counters and brakes (spec agent-auto-iterate-2026-11-16 §3–§5, 11-18 rulings;
audit M1, M2, S1–S6, S11, S12). Real runner backtests in a temp workspace; the quiet rerun is recorded, not spawned.

  - outside a turn nothing is counted or refused
  - a turn id without a ledger is a basic turn (fail-closed)
  - only a successful backtest whose code changed counts; same code never counts, never refused
  - basic: baseline + 1 round, then refused; 3 rounds when the user asked; full: 10, and refused past the deadline
  - sizing / MCPT constants are locked inside a session
  - walk-forward refused while a full session is open; finish puts the best round back and closes
  - another live turn's session refuses; a dead one is closed as it stands
  - paired bootstrap > 1 SE; the good-enough rule per type; params_evaluated accumulates
  - close_turn reports the sessions for telemetry; a baseline-only session is dropped, a stopped one closed as it stands
  - finish restores an untested edit and skips the rerun when the exec test is there; no second session after finish
  - exposure is measured inside iterate (empty / NaN weights never fail the run or block every round)

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_iterate.py
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
for k in ("BLAVE_TURN_ID", "BLAVE_TURN_PID", "BLAVE_MODE", "BLAVE_QUIET"):
    os.environ.pop(k, None)

import numpy as np
import pandas as pd

import lib.iterate as it
import lib.runner as runner
import lib.strategy as strategy

runner.dotenv_values = lambda *a, **k: {}
fails = 0


def check(cond, msg, detail=""):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg + ("" if cond or not detail else f"  → {detail}"))
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="iterate-"))
os.chdir(WS)
runner._REPO_ROOT = WS
strategy._REPO_ROOT = WS
NAME = "itcheck"
SRC = WS / "strategies" / NAME / "strategy.py"
SRC.parent.mkdir(parents=True)
(WS / "manager").mkdir()
(WS / "manager" / "portfolio_config.json").write_text(json.dumps({"amounts": {}, "exchanges": {}}))   # restore's funded gate reads it

n = 2000
idx = pd.date_range("2024-01-01", periods=n, freq="h")
close = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 7.0) + 0.05), index=idx)
DF = pd.DataFrame({"Open": close, "High": close * 1.001, "Low": close * 0.999, "Close": close, "Volume": 1.0}, index=idx)


def signals(period):
    return pd.Series(np.where(np.arange(n) % period < period // 2, 1.0, 0.0), index=idx)


def backtest(code, period=40, size=1.0):
    SRC.write_text(code, encoding="utf-8")
    config = {"STRATEGY_NAME": NAME, "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01", "FEE": 0.0005,
              "MCPT": False, "__file__": str(SRC)}
    try:
        runner.run(config, lambda hdrs: DF, lambda d: signals(period) * size)
        return None
    except SystemExit as e:
        return str(e)


def state():
    return json.loads((SRC.parent / "iterate.json").read_text()) if (SRC.parent / "iterate.json").exists() else {}


def ledger(tid, tier, max_rounds, deadline=None, asked=False):
    d = WS / "state" / "iterate"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{tid}.json").write_text(json.dumps({"v": 1, "turn": tid, "tier": tier, "started": time.time(),
                                               "deadline": deadline, "max_rounds": max_rounds, "user_asked": asked,
                                               "pid": None, "strategies": []}))
    os.environ["BLAVE_TURN_ID"] = tid


reruns = []
it._quiet_rerun = lambda name: reruns.append(name)

# ── outside a turn ──
check(backtest("# a\nMCPT = False\n") is None and not state().get("open"), "outside a turn: nothing counted")
check(it.turn() is None, "turn() is None without BLAVE_TURN_ID")

# ── a turn id without a ledger = basic ──
os.environ["BLAVE_TURN_ID"] = "0" * 16
t = it.turn()
check(t["tier"] == "basic" and t["max_rounds"] == 1 and t.get("unread"), "no ledger → basic (fail-closed)", t)
os.environ["BLAVE_TURN_ID"] = "../../etc"
check(it.turn()["tier"] == "basic", "a malformed turn id → basic")

# ── basic: baseline + 1 round ──
T1 = "a" * 16
ledger(T1, "basic", 1)
check(backtest("# a\nMCPT = False\n") is None and state().get("open") is None, "same code as the current version: not counted")
check(backtest("# b\nMCPT = False\n", period=30) is None and len(state()["open"]["rounds"]) == 1, "first changed-code run opens the session (round 0)")
check(backtest("# b\nMCPT = False\n", period=30) is None and len(state()["open"]["rounds"]) == 1, "rerun of the same code: not counted, not refused")
SRC.write_text("# e\nMCPT = False\n", encoding="utf-8")
try:
    runner.run({"STRATEGY_NAME": NAME, "SYMBOL": "BTCUSDT", "INTERVAL": "1h", "START": "2024-01-01", "FEE": 0.0005,
                "MCPT": False, "__file__": str(SRC)}, lambda hdrs: DF, lambda d: 1 / 0)
except ZeroDivisionError:
    pass
check(len(state()["open"]["rounds"]) == 1, "a backtest that crashed is not counted")
check(backtest("# c\nMCPT = False\n", period=50) is None and len(state()["open"]["rounds"]) == 2, "one round (the adopted parameters) allowed")
msg = backtest("# d\nMCPT = False\n", period=60)
check(msg is not None and "Round limit" in msg and len(state()["open"]["rounds"]) == 2, "basic: a second round is refused, nothing run", msg)
check(backtest("# c\nMCPT = False\n", period=50) is None, "after the cap a same-code rerun still runs")

# ── finish (basic): quiet rerun, closes ──
reruns.clear()
last = it.finish(NAME)
check(reruns == [NAME] and state()["open"] is None and last["tier"] == "basic" and last["rounds"] == 1,
      "finish (basic): one quiet rerun for the exec test, session closed", (reruns, last))

# ── user asked: 3 rounds ──
T2 = "b" * 16
ledger(T2, "basic", 3, asked=True)
for i, p in enumerate((32, 34, 36, 38)):
    backtest(f"# asked {i}\nMCPT = False\n", period=p)
check(len(state()["open"]["rounds"]) == 4, "user asked to optimise: baseline + 3 rounds")
check("Round limit" in (backtest("# asked x\nMCPT = False\n", period=44) or ""), "…and the 4th round is refused")
it.finish(NAME)

# ── full: locked constants, deadline, walk-forward, best round back ──
T3 = "c" * 16
ledger(T3, "full", 10, deadline=time.time() + 600)
backtest("# full 0\nMCPT = False\nLEVERAGE = 1\n", period=40)
msg = backtest("# full 1\nMCPT = False\nLEVERAGE = 2\n", period=42)
check(msg is not None and "LEVERAGE" in msg, "full: leverage changed inside the session → refused", msg)
msg = backtest("# full 1\nMCPT = True\nLEVERAGE = 1\n", period=42)
check(msg is not None and "MCPT" in msg, "MCPT switched on/off inside the session → refused", msg)
backtest("# full 1\nMCPT = False\nLEVERAGE = 1\n", period=42, size=2.0)
op = state()["open"]
check(op["rounds"][-1]["eligible"] is False and op["best"] == op["rounds"][0]["n"],
      "exposure went up (sizing in compute_signals): the round is not eligible as best", op["rounds"][-1])
try:
    import lib.walk_forward as wf
    wf.run_walk_forward(DF, lambda d, a=1, b=1: signals(40), [1], [1], f"strategies/{NAME}", "A", "B", fee=0.0005)
    check(False, "walk-forward refused while the full session is open")
except SystemExit as e:
    check("finish" in str(e), "walk-forward refused while the full session is open")
best = op["best"]
cur_before = strategy.load_index(NAME)["current"]
reruns.clear()
it.finish(NAME)
check(strategy.load_index(NAME)["current"] == best and reruns == [NAME] and state()["open"] is None,
      "finish (full): the best round's code is back (current = best), rerun once, closed",
      (best, cur_before, strategy.load_index(NAME)["current"], reruns))
T4 = "d" * 16
ledger(T4, "full", 10, deadline=time.time() - 1)
backtest("# late 0\nMCPT = False\n", period=46)
check("iteration time is used up" in (backtest("# late 1\nMCPT = False\n", period=48) or ""), "full: past the deadline a new round is refused")
it.finish(NAME)

# ── another turn's session ──
T5, T6 = "e" * 16, "f" * 16
ledger(T5, "full", 10)
backtest("# other 0\nMCPT = False\n", period=52)
st = state()
st["open"]["pid"] = f"{os.getpid()}:"   # this process: alive
(SRC.parent / "iterate.json").write_text(json.dumps(st))
ledger(T6, "full", 10)
msg = backtest("# other 1\nMCPT = False\n", period=54)
check(msg is not None and "Another conversation" in msg, "another live turn iterating the strategy → refused", msg)
st = state()
st["open"]["started"] = time.time() - it.STALE_S - 5
(SRC.parent / "iterate.json").write_text(json.dumps(st))
check(backtest("# other 1\nMCPT = False\n", period=54) is None and state()["open"]["turn"] == T6
      and state()["last"]["turn"] == T5 and state()["last"]["stop"] == "fault",
      "a dead turn's session is closed as it stands (fault) and this turn opens its own")

# ── close_turn: what the runtime calls at turn end ──
import contextlib, io


def closed(tid, stop):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        out = it.close_turn(tid, stop)
    return out, json.loads(buf.getvalue().strip().splitlines()[-1])


reruns.clear()
out, printed = closed(T6, "done")
check(out == [] and printed == [] and state()["open"] is None and reruns == [] and state()["last"]["turn"] == T5,
      "close_turn: a baseline-only session (no round, no scan: Adopt, library as is, just a backtest) is dropped — no rerun, "
      "no telemetry line (audit 0.1.59 B-4)", (out, reruns, state().get("last")))
T7 = "1" * 16
ledger(T7, "full", 10, deadline=time.time() + 600)
backtest("# stop 0\nMCPT = False\n", period=40)
backtest("# stop 1\nMCPT = False\n", period=44)
cur7 = strategy.load_index(NAME)["current"]
SRC.write_text("# stop 2, edited, never run\nMCPT = False\n", encoding="utf-8")
reruns.clear()
out, printed = closed(T7, "user")
check(out == [{"tier": "full", "stop": "user", "rounds": 1}] and printed == out and state()["open"] is None and reruns == []
      and strategy.load_index(NAME)["current"] == cur7 and SRC.read_text().startswith("# stop 2"),
      "close_turn after Stop: closed as it stands — no revert, no quiet rerun, the file untouched (audit 0.1.59 M1)",
      (out, reruns, strategy.load_index(NAME)["current"], cur7))

# ── B-4: a scan is the flow running; a baseline alone does not hold walk-forward back ──
T8 = "2" * 16
ledger(T8, "full", 10, deadline=time.time() + 600)
backtest("# scan 0\nMCPT = False\n", period=40)
try:
    it.before_walk_forward(NAME)
    wf_ok = True
except SystemExit:
    wf_ok = False
check(wf_ok and not state()["open"].get("scanned"), "full, baseline only: walk-forward is not held back (no flow running)")
it.note_params(NAME, 4)
try:
    it.before_walk_forward(NAME)
    wf_held = False
except SystemExit as e:
    wf_held = "finish" in str(e)
check(state()["open"].get("scanned") is True and wf_held, "…a scan in the session marks the flow running: walk-forward held until finish")
stats_path = SRC.parent / "stats.json"
st_json = json.loads(stats_path.read_text())
st_json["exec_test"] = {"code_hash": strategy.code_hash(SRC.read_bytes()), "lags": {}}
stats_path.write_text(json.dumps(st_json))
reruns.clear()
out, _ = closed(T8, "done")
check(out == [{"tier": "full", "stop": "done", "rounds": 0}] and reruns == [],
      "close-out (finish): stats.json already has the 成交測試 block for this code → no rerun (audit 0.1.59 B-4)", (out, reruns))

# ── B-3: finish puts an edit nobody backtested back to the current version ──
T9 = "3" * 16
ledger(T9, "basic", 1)
backtest("# edit 0\nMCPT = False\n", period=40)
cur9 = strategy.load_index(NAME)["current"]
SRC.write_text("# edit 1, never run\nMCPT = False\n", encoding="utf-8")
reruns.clear()
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    it.finish(NAME)
pre = strategy.versions_dir(NAME) / "pre-restore.py"
check(SRC.read_text().startswith("# edit 0") and strategy.load_index(NAME)["current"] == cur9 and reruns == [NAME]
      and pre.is_file() and pre.read_text().startswith("# edit 1") and f"final version v{cur9}" in buf.getvalue(),
      "finish: strategy.py edited after the last backtest → the current version's code back (the edit kept in pre-restore.py), then the rerun (audit 0.1.59 B-3)",
      (SRC.read_text()[:20], cur9, reruns, buf.getvalue()))

# ── B-7: exposure measured inside iterate, never NaN ──
check(it._exposure(np.array([0.5, -1.0, np.nan])) == 1.0 and it._exposure(np.array([[0.5, -0.5], [1.0, np.nan]])) == 1.0
      and it._exposure(np.array([])) is None and it._exposure(np.array([np.nan, np.nan])) is None and it._exposure(None) is None,
      "_exposure: 1-D peak |w|, 2-D peak row sum, empty / all-NaN → None (no ValueError out of the runner)")
RUN_SRC = Path(ROOT, "lib", "runner.py").read_text()
check(RUN_SRC.count("_iterate('after_backtest', strategy_name, src0, stats, ver, w_curr)") == 2 and "nanmax(np.abs(w_curr))" not in RUN_SRC,
      "runner hands the raw weights to after_backtest (both Type A and Type C), computes no exposure itself")
T11 = "5" * 16
ledger(T11, "full", 10, deadline=time.time() + 600)
backtest("# nan 0\nMCPT = False\n", period=40)
st = state()
st["open"]["exposure0"] = float("nan")
(SRC.parent / "iterate.json").write_text(json.dumps(st))
backtest("# nan 1\nMCPT = False\n", period=44)
check(state()["open"]["turn"] == T11 and len(state()["open"]["rounds"]) == 2 and state()["open"]["rounds"][-1]["eligible"] is True, "a session whose baseline exposure is NaN does not mark every later round 'exposure went up'",
      state()["open"]["rounds"][-1])
with contextlib.redirect_stdout(io.StringIO()):
    it.close_turn(T11, "done")

# ── B-2: finished this turn → a new changed-code run does not open a second session ──
T10 = "4" * 16
ledger(T10, "basic", 1)
backtest("# again 0\nMCPT = False\n", period=40)
backtest("# again 1\nMCPT = False\n", period=44)
with contextlib.redirect_stdout(io.StringIO()):
    it.finish(NAME)
msg = backtest("# again 2\nMCPT = False\n", period=48)
check(msg is not None and "already finished this turn" in msg and state()["open"] is None,
      "basic: after finish, another changed-code backtest in the same turn is refused, not a fresh round count (audit 0.1.59 B-2)", msg)
check(backtest("# again 1\nMCPT = False\n", period=44) is None, "…the finished version's same-code rerun still runs")

# ── params_evaluated ──
before = state()["params_evaluated"]
it.note_params(NAME, 120)
check(state()["params_evaluated"] == before + 120, "write_scan cells add to params_evaluated")
import lib.param_scan as ps
from lib.param_scan import write_scan
ps._IMPORTED_AT = time.time() + 1   # a scan process started after the last edit (the stale-scan guard is not under test)
g = np.full((2, 2), 1.0)
write_scan(g, [1, 2], [1, 2], g, (0, 0), f"strategies/{NAME}", "A", "B", 0.0005, None, None)
check(state()["params_evaluated"] == before + 124, "…counted from write_scan itself (4 cells)")

# ── bootstrap, good enough, plan ──
vd = strategy.versions_dir(NAME)
days = [f"2024-{m:02d}-{d:02d}" for m in range(1, 7) for d in range(1, 29)]
rng = np.random.default_rng(1)
base = rng.normal(0.0005, 0.01, len(days))
for v, r in ((901, base), (902, base + 0.002), (903, base + rng.normal(0, 0.0001, len(days)))):
    (vd / f"v{v}.json").write_text(json.dumps({"daily_dates": days, "daily_returns": list(map(float, r))}))
check(it.improved(NAME, 902, 901)[0] is True, "a clearly better curve beats one SE")
check(it.improved(NAME, 903, 901)[0] is False, "noise around the same curve does not")
check(it.good_enough({"Sharpe Ratio": 1.2, "Benchmark Sharpe Ratio": 0.8, "MCPT p-value": 0.01}), "Type A: beats B&H Sharpe and p < 0.05 → good")
check(not it.good_enough({"Sharpe Ratio": 1.2, "Benchmark Sharpe Ratio": 0.8}), "Type A without a p-value → not good")
check(not it.good_enough({"Sharpe Ratio": 0.5, "Benchmark Sharpe Ratio": 0.8, "MCPT p-value": 0.01}), "Type A under the B&H Sharpe → not good")
check(it.good_enough({"Sharpe Ratio": 1.0, "Total Return [%]": 90.0, "benchmark_bh": {"sharpe_ratio": 0.7, "ret_pct": 80.0}}),
      "Type C: beats the B&H benchmark's Sharpe (and its return)")
check(it.good_enough({"Sharpe Ratio": 1.0, "benchmark_strategy_sharpe_pct": 80, "benchmark_strategy_ret_pct": 80})
      and not it.good_enough({"Sharpe Ratio": 1.0, "benchmark_strategy_sharpe_pct": 79.9, "benchmark_strategy_ret_pct": 80}),
      "mixed Type C: ≥ 80th percentile of random portfolios")
stats = json.loads((SRC.parent / "stats.json").read_text())
check(isinstance(stats.get("Benchmark Sharpe Ratio"), (int, float)), "Type A stats.json carries the B&H Sharpe")
os.environ["BLAVE_TURN_ID"] = T1
(SRC.parent / "source.json").write_text("{}")
check(it.plan(NAME)["checks_only"] in (None, "library") and it.plan(NAME)["tier"] == "basic", "plan(): tier from the ledger", it.plan(NAME))
os.environ.pop("BLAVE_TURN_ID", None)
check(it.plan(NAME)["tier"] == "full", "plan() outside a turn (BYO): full")

# ── Type C: the return floor (spec typec-iterate-return-floor-2026-11-27 §4.1, §5) ──
def tc_stats(ret, sharpe=1.0, bench_ret=50.0, bench_sharpe=0.5, trades=40, mixed=None):
    st = {"Sharpe Ratio": sharpe, "Total Return [%]": ret, "Trades": trades}
    if mixed is not None:
        st.update({"benchmark_strategy_sharpe_pct": mixed[0], "benchmark_strategy_ret_pct": mixed[1]})
    else:
        st["benchmark_bh"] = None if bench_ret is None else {"ret_pct": bench_ret, "sharpe_ratio": bench_sharpe}
    return st


def judged(name, tid, base_ret, round_ret, curve, bench_ret=50.0, drop_best_ret=False):
    """A Type C session through after_backtest itself: baseline v1 (return base_ret), then v2 whose daily curve is
    `curve` ('better' beats one SE, 'noise' does not) and whose return is round_ret. Returns (round, op, printed)."""
    ledger(tid, "full", 10, deadline=time.time() + 600)
    vdir = strategy.versions_dir(name)
    vdir.mkdir(parents=True, exist_ok=True)
    r2 = base + 0.002 if curve == "better" else base + rng.normal(0, 0.0001, len(days))
    for v, r in ((1, base), (2, r2)):
        (vdir / f"v{v}.json").write_text(json.dumps({"daily_dates": days, "daily_returns": list(map(float, r))}))
    with contextlib.redirect_stdout(io.StringIO()):
        it.after_backtest(name, b"# base\n", tc_stats(base_ret, bench_ret=bench_ret), 1)
    if drop_best_ret:
        st_ = json.loads((WS / "strategies" / name / "iterate.json").read_text())
        st_["open"]["rounds"][0].pop("ret", None)
        (WS / "strategies" / name / "iterate.json").write_text(json.dumps(st_))
    buf_ = io.StringIO()
    with contextlib.redirect_stdout(buf_):
        it.after_backtest(name, b"# round\n", tc_stats(round_ret, bench_ret=bench_ret), 2)
    op_ = json.loads((WS / "strategies" / name / "iterate.json").read_text())["open"]
    return op_["rounds"][-1], op_, buf_.getvalue()


# must be red on the old code
check(not it.good_enough(tc_stats(40.0, sharpe=1.0, bench_ret=80.0, bench_sharpe=0.7)),
      "Type C: Sharpe beats the benchmark but the return trails it → not good enough")
check(not it.good_enough(tc_stats(40.0, mixed=(80, 79.9))), "mixed Type C: Sharpe at the 80th percentile, return at 79.9 → not good enough")
r, op, out = judged("tc3", "6" * 16, 100.0, 50.0, "better", bench_ret=80.0)
check(r.get("kept") is False and r.get("floor") is False and op["best"] == 1
      and "return fell below the best round's and trails the benchmark" in out,
      "Type C round: Sharpe beats one SE but the return fell below the best round's and trails the benchmark → not kept", (r, out))
floor_rounds = []
r, _, _ = judged("tc10", "7" * 16, 100.0, 90.0, "better", bench_ret=80.0)
floor_rounds.append(r)
check(r.get("kept") is True, "Type C round: return below the best round's but still above the benchmark → kept", r)
r, _, _ = judged("tc12", "8" * 16, 100.0, 10.0, "better", bench_ret=80.0, drop_best_ret=True)
floor_rounds.append(r)
check(r.get("kept") is True, "an open session from before the floor (best round has no ret) is not compared", r)
check(not it.good_enough(tc_stats(200.0, bench_ret=None)), "benchmark_bh None (fetch failed, key kept) → not good enough")
r, _, _ = judged("tc13", "9" * 16, 100.0, 120.0, "better", bench_ret=None)
floor_rounds.append(r)
check(r.get("kept") is True, "benchmark_bh None: a return not below the best round's → kept", r)
for nm, tid, bad in (("tc14a", "a1" * 8, None), ("tc14b", "a2" * 8, float("nan"))):
    r, _, _ = judged(nm, tid, 100.0, bad, "better", bench_ret=80.0)
    floor_rounds.append(r)
    check(r.get("kept") is True, f"this round's Total Return is {bad!r} → not compared, kept follows improved", r)
check(len(floor_rounds) == 5 and all(x.get("floor") is True for x in floor_rounds),
      "Type C rounds that pass (or are not compared) record floor True", [x.get("floor") for x in floor_rounds])

# green on the old code too
check(it.good_enough(tc_stats(90.0, sharpe=1.0, bench_ret=80.0, bench_sharpe=0.7))
      and it.good_enough(tc_stats(90.0, mixed=(80, 80))), "Type C / mixed: both beat the benchmark → good enough")
check("benchmark_bh" not in stats and "benchmark_strategy_sharpe_pct" not in stats,
      "a Type A stats.json carries neither benchmark_bh nor benchmark_strategy_sharpe_pct (the Type C split keys)")
ledger("a3" * 8, "full", 10)
(strategy.versions_dir("ta9")).mkdir(parents=True, exist_ok=True)
for v, rr in ((1, base), (2, base + 0.002)):
    (strategy.versions_dir("ta9") / f"v{v}.json").write_text(json.dumps({"daily_dates": days, "daily_returns": list(map(float, rr))}))
with contextlib.redirect_stdout(io.StringIO()):
    it.after_backtest("ta9", b"# a\n", {"Sharpe Ratio": 1.0, "Total Return [%]": 100.0, "Trades": 40, "Benchmark Sharpe Ratio": 0.5}, 1)
    it.after_backtest("ta9", b"# b\n", {"Sharpe Ratio": 1.2, "Total Return [%]": 10.0, "Trades": 40, "Benchmark Sharpe Ratio": 0.5}, 2)
r = json.loads((WS / "strategies" / "ta9" / "iterate.json").read_text())["open"]["rounds"][-1]
check("floor" not in r and r["kept"] is True, "Type A round: no floor key, kept by improved alone (a lower return does not matter)", r)
ledger("a4" * 8, "basic", 1)
with contextlib.redirect_stdout(io.StringIO()):
    it.after_backtest("tc15", b"# a\n", tc_stats(100.0, trades=5), None)
    it.after_backtest("tc15", b"# b\n", tc_stats(10.0, trades=5), None)
    try:
        it.finish("tc15")
        ok15 = True
    except Exception as e:
        ok15 = repr(e)
check(ok15 is True, "no eligible round (best is None) → finish does not revert or raise", ok15)

# real Type C backtests for finish / close_turn
CN = 600
CIDX = pd.bdate_range("2023-01-02", periods=CN)
crng = np.random.default_rng(11)
CCLOSE = pd.DataFrame(100 * np.exp(np.cumsum(crng.normal(0.0006, 0.012, (CN, 5)), axis=0)), index=CIDX,
                      columns=["2330", "2317", "2454", "2303", "1301"])
COPEN = CCLOSE.shift(1).fillna(CCLOSE.iloc[0])
BENCH = {"close": None}
runner._pick_benchmark = lambda *a, **k: ("0050", "0050_bh", True, lambda s, e: BENCH["close"][s:e])


def set_bench(total_pct):
    b_idx = pd.bdate_range("2022-12-01", "2025-12-31")
    BENCH["close"] = pd.Series(np.linspace(100, 100 * (1 + total_pct / 100), len(b_idx)), index=b_idx)


def tc_weights(c, scale):
    mom = c.pct_change(20, fill_method=None)
    rank = mom.rank(axis=1, ascending=False, method="first", na_option="bottom")
    w = pd.DataFrame(np.where((rank <= 2) & mom.notna(), 0.5, 0.0), index=c.index, columns=c.columns)
    wk = pd.Series(c.index.to_period("W"), index=c.index)
    w[~(wk != wk.shift(1)).to_numpy()] = np.nan
    return w.ffill().fillna(0.0).values * scale


def tc_backtest(name, code, scale=1.0):
    src = WS / "strategies" / name / "strategy.py"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(code, encoding="utf-8")
    cfg = {"STRATEGY_NAME": name, "INTERVAL": "1d", "START": "2023-01-02", "FEE": 0.001, "WARMUP": 20, "__file__": str(src)}
    with contextlib.redirect_stdout(io.StringIO()) as b:
        try:
            runner.run(cfg, lambda h: (CCLOSE.copy(), COPEN.copy()),
                       lambda d: (tc_weights(d[0], scale), pd.concat({"close": d[0], "open": d[1]}, axis=1)))
        except SystemExit as e:
            return str(e)
    return None


def tc_state(name):
    return json.loads((WS / "strategies" / name / "iterate.json").read_text())


def finish_out(name, stop=None):
    b = io.StringIO()
    with contextlib.redirect_stdout(b):
        it.finish(name, stop)
    return b.getvalue()


set_bench(5000.0)   # every version trails the benchmark
ledger("b1" * 8, "basic", 1)
tc_backtest("tcf4", "# c0\n")
tc_backtest("tcf4", "# c1 half\n", scale=0.5)
rr = tc_state("tcf4")["open"]["rounds"]
base4 = rr[0]["n"]
check(len(rr) == 2 and rr[0].get("eligible") and rr[1].get("eligible") and rr[1].get("floor") is False,
      "real Type C: the half-size round trails the benchmark and the baseline's return (floor False)", rr)
reruns.clear()
out4 = finish_out("tcf4")
check(strategy.load_index("tcf4")["current"] == base4 and (WS / "strategies" / "tcf4" / "strategy.py").read_text().startswith("# c0")
      and "put back:" in out4 and f"final version v{base4}" in out4,
      "basic Type C, floor False → finish puts the baseline back and says why", (strategy.load_index("tcf4")["current"], out4))

ledger("b2" * 8, "basic", 3, asked=True)
tc_backtest("tcf5", "# c0\n")
tc_backtest("tcf5", "# c1\n", scale=0.6)
tc_backtest("tcf5", "# c2\n", scale=0.4)
base5 = tc_state("tcf5")["open"]["rounds"][0]["n"]
finish_out("tcf5")
check(strategy.load_index("tcf5")["current"] == base5, "basic + 「幫我優化」 (3 rounds): the last round below the floor → put back to the best round (Wei 11-27)")

T_C6 = "b3" * 8
ledger(T_C6, "basic", 1)
tc_backtest("tcf6", "# c0\n")
tc_backtest("tcf6", "# c1\n", scale=0.5)
base6 = tc_state("tcf6")["open"]["rounds"][0]["n"]
with contextlib.redirect_stdout(io.StringIO()):
    it.close_turn(T_C6, "time")
check(strategy.load_index("tcf6")["current"] == base6, "a turn that ends without finish: close_turn puts the floor-failing round back too")

ledger("b4" * 8, "full", 10, deadline=time.time() + 600)
tc_backtest("tcf16", "# c0\n")
tc_backtest("tcf16", "# c1\n", scale=0.5)
reverts = []
_orig_revert = it.revert_to
it.revert_to = lambda name, n: reverts.append((name, n))
try:
    finish_out("tcf16")
finally:
    it.revert_to = _orig_revert
check(len(reverts) == 1, "full Type C, floor False: put back once (not once per reason)", reverts)

T_C17 = "b5" * 8
ledger(T_C17, "full", 10, deadline=time.time() + 600)
tc_backtest("tcf17", "# c0\n")
tc_backtest("tcf17", "# c1\n", scale=0.5)
cur17 = strategy.load_index("tcf17")["current"]
reruns.clear()
with contextlib.redirect_stdout(io.StringIO()):
    it.close_turn(T_C17, "user")
check(strategy.load_index("tcf17")["current"] == cur17 and reruns == [] and tc_state("tcf17")["last"]["stop"] == "user",
      "Stop: closed as it stands even when the round failed the floor (no put back, no rerun)")

set_bench(-50.0)   # every version beats the benchmark
ledger("b6" * 8, "basic", 1)
tc_backtest("tcf18", "# c0\n")
tc_backtest("tcf18", "# c1\n", scale=0.5)
rr = tc_state("tcf18")["open"]["rounds"]
cur18 = strategy.load_index("tcf18")["current"]
out18 = finish_out("tcf18")
check(rr[1].get("kept") is False and strategy.load_index("tcf18")["current"] == cur18 != rr[0]["n"] and "put back" not in out18,
      "basic Type C, floor True and not better beyond noise → kept as adopted, no put back (§11)", (rr, out18))
check(f"final version v{cur18}" in out18, "finish names the version the file actually holds (not the best round)", out18)

print()
print("ALL PASS" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
