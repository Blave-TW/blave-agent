"""stats.json `exec_test` (成交測試 tab, lib/runner._exec_test): the 現行 row equals the backtest.

Runs runner.run() end to end on five fixture strategies — Type A, Type A with exec_at_close,
Type A TAIFEX roll with a planted +5% basis gap, Type C with warmup / late listing /
suspension / close-filled rebalances, Type C with the settlement mask on its weights — and
requires lag["0"] to equal stats.json's Sharpe / MDD (Type C: also Ann. Return), the raw k=0
Sharpe to equal the backtest's bit for bit, a lag never to hold a position across a roll, a
performance refresh to recompute (not carry) the block, and the whole grid to fit the budget.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_exec_test_grid.py
"""
import contextlib
import io
import json
import math
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="exec-test-", dir=os.environ.get("SCRATCHPAD") or None))
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
from lib.analysis import precise_pnl, compute_stats

runner.dotenv_values = lambda *a, **k: {}
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

exec_test, _exec_cell, _lagged, _v = runner._exec_test, runner._exec_cell, runner._lagged, runner._round4


# ── harness ──────────────────────────────────────────────────────────────────
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


captured = []
_real_pp, _real_cs = runner.precise_pnl, runner.compute_stats


def _cap_pp(close_v, open_v, w_curr, w_prev, exec_shifted, fee):
    captured.append({"args": tuple(np.array(a, copy=True) if isinstance(a, np.ndarray) else a
                                   for a in (close_v, open_v, w_curr, w_prev, exec_shifted, fee))})
    return _real_pp(close_v, open_v, w_curr, w_prev, exec_shifted, fee)


def _cap_cs(pf_ret, index):
    out = _real_cs(pf_ret, index)
    if captured and "stats" not in captured[-1]:
        captured[-1]["stats"], captured[-1]["index"] = out, index
    return out


runner.precise_pnl, runner.compute_stats = _cap_pp, _cap_cs


def strat(name, market="swap"):
    d = WS / "strategies" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "strategy.py").write_text(f'INTERVAL = "1d"\nMARKET = "{market}"\n# fixture\n')
    return {"STRATEGY_NAME": name, "SYMBOL": "BTCUSDT", "INTERVAL": "1d", "START": "2020-01-01",
            "FEE": 0.0005, "MCPT": False, "MARKET": market, "__file__": str(d / "strategy.py")}


def backtest(cfg, fetch, compute):
    captured.clear()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run(dict(cfg), fetch, compute)
    stats = json.loads((WS / "strategies" / cfg["STRATEGY_NAME"] / "stats.json").read_text())
    return stats, captured[0]


def parity(label, stats, cap):
    close_v, open_v, w_curr, w_prev, exec_shifted, fee = cap["args"]
    sharpe, _, _, mdd, ann = cap["stats"]
    w_prev_re = np.zeros_like(w_curr)
    w_prev_re[1:] = w_curr[:-1]
    check(np.array_equal(w_prev_re, w_prev, equal_nan=True), f"{label}: w_prev rebuilt from w_curr == runner's")
    pf0, *_ = precise_pnl(close_v, open_v, w_curr, w_prev_re, exec_shifted, fee)
    s0 = compute_stats(pf0, cap["index"])[0]
    check(s0 == sharpe, f"{label}: k=0 X=0 raw Sharpe == backtest's bit for bit ({s0!r} vs {sharpe!r})")
    grid = stats.get(runner.EXEC_TEST_KEY)
    check(isinstance(grid, dict) and set(grid["lag"]) == {str(k) for k in runner.EXEC_TEST_LAGS}
          and set(grid["cost"]) == {"free", *runner.EXEC_TEST_EXTRA_PCT},
          f"{label}: stats.json carries {runner.EXEC_TEST_KEY} with every lag and cost cell")
    if not isinstance(grid, dict):
        return {}
    check(grid == json.loads(json.dumps(exec_test(close_v, open_v, w_curr, exec_shifted, fee, cap["index"]))),
          f"{label}: the block is _exec_test of the backtest's own precise_pnl arrays")
    check(grid["lag"]["0"][0] == stats["Sharpe Ratio"],
          f"{label}: grid 現行 Sharpe == stats.json ({grid['lag']['0'][0]} vs {stats['Sharpe Ratio']})")
    check(grid["lag"]["0"][2] == stats["Max Drawdown [%]"],
          f"{label}: grid 現行 MDD == stats.json ({grid['lag']['0'][2]} vs {stats['Max Drawdown [%]']})")
    if "Ann. Return [%]" in stats:
        check(grid["lag"]["0"][1] == stats["Ann. Return [%]"],
              f"{label}: grid 現行 年化 == stats.json ({grid['lag']['0'][1]} vs {stats['Ann. Return [%]']})")
    check(grid["position_changes"] >= 1 and (w_curr.ndim > 1 or grid["position_changes"] == stats["Trades"]),
          f"{label}: position_changes {grid['position_changes']} bars with a trade (stats Trades {stats['Trades']}; equal for Type A)")
    be = grid["breakeven_pct_per_side"]
    if be is not None:
        pf_be, *_ = precise_pnl(close_v, open_v, w_curr, w_prev_re, exec_shifted, be / 100)
        check(abs(pf_be.mean()) < 1e-6, f"{label}: breakeven {be}%/side zeroes the mean return ({pf_be.mean():.2e})")
    json.dumps(grid, allow_nan=False)   # api ingests with allow_nan=False
    return grid


rng = np.random.default_rng(11)
N = 900
IDX = pd.date_range("2020-01-01", periods=N, freq="D")


def ohlc(px, jump=0.0):
    opn = np.r_[px[0], px[:-1]] * np.exp(rng.normal(0, 0.004, len(px)) + jump)
    return pd.DataFrame({"Open": opn, "High": np.maximum(px, opn) * 1.01, "Low": np.minimum(px, opn) * 0.99,
                         "Close": px, "Volume": 1.0}, index=IDX)


def trend(df):
    c = df["Close"]
    return pd.Series(np.where(c > c.rolling(20).mean(), 1.0, -1.0), index=df.index).where(c.rolling(20).count() == 20)


# 1. Type A, plain, with one Open-0 bar (runner drops it)
PX = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.02, N)))
DA = ohlc(PX)
DA.iloc[400, DA.columns.get_loc("Open")] = 0.0
stats, cap = backtest(strat("fa_plain"), lambda h: DA.copy(), trend)
print("Type A plain")
parity("A", stats, cap)

# 2. Type A with a generic exec_at_close mask
EA = pd.Series(rng.random(N) < 0.05, index=IDX)
stats, cap = backtest(strat("fa_eac"), lambda h: DA.copy(), lambda d: (trend(d), EA))
print("Type A exec_at_close")
parity("A eac", stats, cap)
c_, o_, w_, _, e_, f_ = cap["args"]
g = exec_test(c_, o_, w_, e_, f_, cap["index"])
check(g["close_fill"] != g["lag"]["0"], "A eac: close_fill differs from 現行 (mask not all-True)")

# 3. Type A TAIFEX: unadjusted continuous series, +5% basis at every roll, settlement flat
inst = np.repeat(np.arange(N // 20 + 1), 20)[:N]
roll_px = PX * np.exp(0.05 * inst)          # each contract trades 5% above the last
DT = ohlc(roll_px, jump=0.05 * np.r_[0, np.diff(inst)])   # the gap opens the new contract's first bar
DT["instrument_id"] = inst


def txf(d):
    s = trend(d).fillna(0.0)
    settle = pd.Series(d["instrument_id"].values != np.r_[d["instrument_id"].values[1:], -1], index=d.index)
    settle.iloc[-1] = False
    s = s.clip(lower=0.0)
    s[settle] = 0.0
    return s, settle


stats, cap = backtest(strat("fa_txf"), lambda h: DT.copy(), txf)
print("Type A TAIFEX settlement")
grid = parity("A txf", stats, cap)
close_v, open_v, w_curr, _, ex, fee = cap["args"]
roll_bars = np.flatnonzero(ex)
for k in (1, 5, 10):
    wk = _lagged(w_curr, ex, k)
    check(np.all(wk[roll_bars] == 0.0), f"A txf: k={k} holds nothing across the {len(roll_bars)} roll gaps")
naive = np.zeros_like(w_curr)
naive[1:] = w_curr[:-1]
naive_cell, *_ = _exec_cell(close_v, open_v, naive, ex, fee, cap["index"])
check(naive_cell[0] > grid["lag"]["1"][0] + 0.5,
      f"A txf: a plain shift books the +5% gaps (Sharpe {naive_cell[0]} vs anchored {grid['lag']['1'][0]})")

# 4. Type C: 4 non-TW columns (random benchmark, no network), warmup, a late listing,
#    a suspension held through (NaN close / 0 open), monthly rebalance, exec_at_close
K = 4
cols = [f"A{i}USDT" for i in range(K)]
CP = 50 * np.exp(np.cumsum(rng.normal(0.0004, 0.02, (N, K)), axis=0))
CO = np.r_[CP[:1], CP[:-1]] * np.exp(rng.normal(0, 0.004, (N, K)))
CP[:200, 3] = np.nan
CO[:200, 3] = np.nan                        # listed on bar 200
CP[500:506, 1] = np.nan                     # suspended 6 bars, held
CO[500:507, 1] = np.nan
CLOSE = pd.DataFrame(CP, index=IDX, columns=cols)
OPEN = pd.DataFrame(CO, index=IDX, columns=cols)
EAC = np.r_[True, IDX.month[1:] != IDX.month[:-1]] & (rng.random(N) < 0.5)   # some rebalances fill at close
WARMUP = 60


def momentum(d):
    c, o = d
    mom = c.ffill().pct_change(40, fill_method=None)
    w = np.zeros(c.shape)
    month = c.index.to_period("M")
    held = np.zeros(K)
    for t in range(len(c)):
        if t == 0 or month[t] != month[t - 1]:
            m = mom.iloc[t].values
            ok = np.isfinite(m)
            held = np.zeros(K)
            if ok.any():
                top = np.argsort(np.where(ok, m, -np.inf))[::-1][:2]
                held[top[np.isfinite(m[top])]] = 0.5
        w[t] = held
    return w, pd.concat({"close": c, "open": o}, axis=1), EAC


ccfg = dict(strat("fc_mom", market="spot"), SYMBOL=None, WARMUP=WARMUP)
stats, cap = backtest(ccfg, lambda h: (CLOSE.copy(), OPEN.copy()), momentum)
print("Type C momentum")
gridc = parity("C", stats, cap)

# §4.1 reproduction — the same Type C recomputed the ways a script that skips the runner's
# Type C path would. Each line is one omission; none of them can show in Type A.
w_full, pdf, eac_full = momentum((CLOSE, OPEN))
c_raw, o_raw = pdf["close"].values, pdf["open"].values


def sharpe_of(close_v, open_v, w, ex, index):
    wc = np.vstack([np.zeros((1, K)), w[:-1]])
    wp = np.vstack([np.zeros((2, K)), w[:-2]])
    return compute_stats(precise_pnl(close_v, open_v, wc, wp, ex, ccfg["FEE"])[0], index)[0]


def ex_of(m):
    e = np.zeros(len(m), dtype=bool)
    e[1:] = m[:-1]
    return e


sl = slice(WARMUP, None)
fc, fo = runner._fill_invalid_cells(c_raw[sl], o_raw[sl])
ref = sharpe_of(fc, fo, w_full[sl], ex_of(eac_full[sl]), IDX[sl])
check(_v(ref) == stats["Sharpe Ratio"], f"C repro: runner path rebuilt by hand == stats.json ({_v(ref)})")
variants = {
    "no _fill_invalid_cells": sharpe_of(c_raw[sl], o_raw[sl], w_full[sl], ex_of(eac_full[sl]), IDX[sl]),
    "exec_at_close dropped": sharpe_of(fc, fo, w_full[sl], np.zeros(N - WARMUP, dtype=bool), IDX[sl]),
    "WARMUP not sliced": sharpe_of(*runner._fill_invalid_cells(c_raw, o_raw), w_full, ex_of(eac_full), IDX),
}
rows = np.isfinite(c_raw[sl]).all(axis=1) & (o_raw[sl] > 0).all(axis=1)
variants["Type A row drop"] = sharpe_of(c_raw[sl][rows], o_raw[sl][rows], w_full[sl][rows],
                                        ex_of(eac_full[sl])[rows], IDX[sl][rows])
for name, s in variants.items():
    print(f"        {name:<24} Sharpe {s:.4f}  ({(s / ref - 1) * 100:+.1f}% vs runner {ref:.4f})")
check(all(abs(s - ref) > 1e-6 for s in variants.values()), "C repro: every omission moves the Type C Sharpe")

# 5. Type C with the TAIFEX mask on weights (Type C settlement usage in txf_settlement_mask's docstring)
CT = CLOSE.copy()
CT.iloc[:, :] = np.nan_to_num(CP, nan=50.0) * np.exp(0.05 * inst)[:, None]
OT = CT.shift(1).fillna(CT.iloc[0]) * np.exp(0.05 * (inst - np.r_[inst[0], inst[:-1]]))[:, None]
SETTLE = inst != np.r_[inst[1:], -1]
SETTLE[-1] = False


def mom_settle(d):
    w, p, _ = momentum(d)
    w[SETTLE] = 0.0
    return w, p, SETTLE


stats, cap = backtest(dict(strat("fc_txf", market="spot"), SYMBOL=None),
                      lambda h: (CT.copy(), OT.copy()), mom_settle)
print("Type C settlement")
parity("C txf", stats, cap)
_, _, wc, _, ex, _ = cap["args"]
check(all(np.all(_lagged(wc, ex, k)[np.flatnonzero(ex)] == 0.0) for k in (1, 5, 10)),
      "C txf: lagged weights are flat on every settlement-priced bar")

# 6. Performance refresh recomputes on the longer data — a carried block would no longer match
print("Refresh / failure")
rcfg = strat("fa_refresh")
old, _ = backtest(rcfg, lambda h: DA.iloc[:-60].copy(), trend)
os.environ.update(BLAVE_MODE="live", **{runner.STATS_REFRESH_ENV: "1"})
try:
    new, cap = backtest(rcfg, lambda h: DA.copy(), trend)
finally:
    os.environ["BLAVE_MODE"] = "backtest"
    os.environ.pop(runner.STATS_REFRESH_ENV, None)
check(new["end"] != old["end"] and new["Sharpe Ratio"] != old["Sharpe Ratio"], "refresh: longer data, Sharpe moved")
check(new.get(runner.EXEC_TEST_KEY, {}).get("lag", {}).get("0", [None])[0] == new["Sharpe Ratio"],
      f"refresh: exec_test recomputed, 現行 == the refreshed Sharpe ({new['Sharpe Ratio']})")

real_cell = runner._exec_cell
runner._exec_cell = lambda *a, **k: 1 / 0
try:
    broken, _ = backtest(strat("fa_broken"), lambda h: DA.copy(), trend)
finally:
    runner._exec_cell = real_cell
check(runner.EXEC_TEST_KEY not in broken and broken.get("Sharpe Ratio") is not None,
      "a failing exec_test drops only its key; the backtest's stats.json is still written")

# ── cost: the spec's largest sample (51k bars × 1) and the widest TW universe (2752 × 283)
for n, k in ((51007, None), (2752, 283)):
    shape = (n,) if k is None else (n, k)
    cv = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, shape), axis=0))
    ov = np.r_[cv[:1], cv[:-1]] * np.exp(rng.normal(0, 0.002, shape))
    wv = np.sign(rng.normal(size=shape)) * (rng.random(shape) < 0.3) / (1 if k is None else k)
    wv = np.r_[np.zeros((1,) + shape[1:]), wv[:-1]]
    exv = np.zeros(n, dtype=bool)
    ix = pd.date_range("2019-01-01", periods=n, freq="h" if k is None else "D")
    t0 = time.perf_counter()
    exec_test(cv, ov, wv, exv, 0.0005, ix)
    dt = time.perf_counter() - t0
    print(f"        {n}×{k or 1}: {dt * 1000:.0f} ms for the whole grid")
    check(dt < 1.0, f"cost {n}×{k or 1} under 1 s ({dt:.3f}s)")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}  (workspace {WS})")
sys.exit(1 if fails else 0)
