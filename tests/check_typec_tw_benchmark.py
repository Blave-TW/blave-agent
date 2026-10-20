"""Minimal check: a Taiwan Type C (every column a TW stock / ETF code) is benchmarked against
0050 buy-and-hold on the adjusted close — stats['benchmark_bh'] — and draws no random
portfolios; a crypto or mixed universe keeps the random benchmark exactly as before; a failed
0050 fetch leaves benchmark_bh null without failing the backtest; every shape still reads as a
portfolio to strategy_reporter.is_portfolio_stats.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_typec_tw_benchmark.py
"""
import contextlib
import io
import json
import math
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
os.environ.setdefault("MPLBACKEND", "Agg")

import numpy as np
import pandas as pd

import lib.data as D
import lib.runner as runner
from lib.analysis import compute_stats
import strategy_reporter as sr  # noqa: E402

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="typec-tw-bench-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(3)
IDX = pd.bdate_range("2024-01-02", periods=300)
TW = ["2330", "2317", "2454", "6488.TWO", "1301"]
CLOSE = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, (300, 5)), axis=0)),
                     index=IDX, columns=TW)
OPEN = CLOSE.shift(1).fillna(CLOSE.iloc[0])

# 0050 adjusted close: starts before the strategy, has a five-day trading halt mid-window
# (no rows — what the 2025 split looked like) and a known level on every traded day
B_IDX = pd.bdate_range("2023-12-15", "2025-03-01")
B_IDX = B_IDX[(B_IDX < "2024-06-11") | (B_IDX > "2024-06-17")]
B_CLOSE = pd.Series(50 * np.exp(np.cumsum(rng.normal(0.0004, 0.01, len(B_IDX)))), index=B_IDX)
calls = []
plots = {}
_plot = runner.plot_pnl_portfolio


def spy_plot(pf, close_df, title="", **kw):
    plots[title] = kw.get("bench_line")
    return _plot(pf, close_df, title=title, **kw)


runner.plot_pnl_portfolio = spy_plot


def fake_0050(stock_id, start, end, headers):
    calls.append((stock_id, start, end))
    b = B_CLOSE[start:end]
    return pd.DataFrame({"Open": b, "Close": b})


def compute(data):
    c, o = data
    mom = c.pct_change(20, fill_method=None)
    rank = mom.rank(axis=1, ascending=False, method="first", na_option="bottom")
    w = pd.DataFrame(np.where((rank <= 2) & mom.notna(), 0.5, 0.0), index=c.index, columns=c.columns)
    s = pd.Series(c.index.to_period("W"), index=c.index)
    w[~(s != s.shift(1)).to_numpy()] = np.nan
    return w.ffill().fillna(0.0).values, pd.concat({"close": c, "open": o}, axis=1)


def run(name, cols, fetch):
    D.fetch_twstock_price_adj = fetch
    c, o = CLOSE.set_axis(cols, axis=1), OPEN.set_axis(cols, axis=1)
    with contextlib.redirect_stdout(io.StringIO()):
        runner.run({"STRATEGY_NAME": name, "INTERVAL": "1d", "START": "2024-01-02", "FEE": 0.003,
                    "WARMUP": 20}, lambda h: (c.copy(), o.copy()), compute)
    return json.loads((WS / "strategies" / name / "stats.json").read_text())


RANDOM_KEYS = ("benchmark_n", "benchmark_strategy_ret_pct", "benchmark_band")

# ── Taiwan universe → 0050 buy-and-hold ──
st = run("tw", TW, fake_0050)
bh = st.get("benchmark_bh") or {}
first, last = pd.Timestamp(st["start"]), pd.Timestamp(st["end"])
px = B_CLOSE.reindex(B_CLOSE.index.union(IDX)).ffill()
want = (px[last] / px[first] - 1) * 100
check(bh.get("kind") == "0050_bh" and bh.get("symbol") == "0050" and bh.get("fee_pct") == 0,
      f"Taiwan Type C writes benchmark_bh kind 0050_bh, no fees ({bh.get('kind')}, {bh.get('fee_pct')})")
check(abs(bh.get("ret_pct", math.nan) - want) <= 0.0051,
      f"ret_pct = 0050 close at the last bar / at the first bar − 1 ({bh.get('ret_pct')} vs {want:.2f})")
bars = IDX[IDX >= first]
b_ret = px.reindex(bars).pct_change().fillna(0).values
_, _, _, mdd, ann = compute_stats(b_ret, bars)
check(abs(bh.get("mdd_pct", math.nan) - mdd * 100) <= 0.0051
      and abs(bh.get("cagr_pct", math.nan) - ann * 100) <= 0.0051,
      f"mdd_pct / cagr_pct from compute_stats on the same bars ({bh.get('mdd_pct')}/{bh.get('cagr_pct')} "
      f"vs {mdd * 100:.2f}/{ann * 100:.2f})")
ser = bh.get("series") or []
check(len(ser) == len(st["daily_dates"]) and ser[0] == 1.0
      and abs((ser[-1] - 1) * 100 - bh["ret_pct"]) <= 0.01,
      f"series: one point per daily_dates ({len(ser)} vs {len(st['daily_dates'])}), 1.0 → 1 + ret")
halt = [ser[i] for i, d in enumerate(st["daily_dates"]) if "2024-06-10" <= d <= "2024-06-17" and i < len(ser)]
check(len(halt) == 8 and len(set(halt)) == 1, f"halt days carry the last traded close (flat: {halt})")
check(calls and calls[-1][0] == "0050" and calls[-1][1] <= st["start"] and calls[-1][2] >= st["end"],
      f"0050 fetched over the backtest's window ({calls[-1] if calls else None})")
check(not [k for k in RANDOM_KEYS if k in st], "Taiwan Type C draws no random portfolios")
check(sr.is_portfolio_stats(st), "is_portfolio_stats still reads Taiwan Type C as a portfolio")
line = plots.get("tw")
check(line is not None and abs((line.iloc[-1] - 1) * 100 - bh["ret_pct"]) <= 0.01,
      "pnl.png draws the 0050 buy-and-hold line")

# ── 0050 fetch fails → null, backtest still written ──
def boom(*a, **k):
    raise RuntimeError("network down")


st = run("tw_down", TW, boom)
check("benchmark_bh" in st and st["benchmark_bh"] is None and st.get("Total Return [%]") is not None,
      "0050 unavailable: benchmark_bh null, stats.json still written")
check(sr.is_portfolio_stats(st), "is_portfolio_stats reads it as a portfolio even then")

# ── 0050 has no price on or before the first bar → null, not a series from a later start ──
late = B_CLOSE[B_CLOSE.index > "2024-03-01"]
st = run("tw_late", TW, lambda *a, **k: pd.DataFrame({"Open": late, "Close": late}))
check("benchmark_bh" in st and st["benchmark_bh"] is None,
      "0050 starting after the first bar: benchmark_bh null")

# ── crypto and mixed universes: the random benchmark, unchanged ──
for name, cols in (("crypto", ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]),
                   ("mixed", ["2330", "2317", "2454", "6488.TWO", "BTCUSDT"])):
    calls.clear()
    st = run(name, cols, fake_0050)
    check(all(k in st for k in RANDOM_KEYS) and "benchmark_bh" not in st and not calls,
          f"{name} Type C keeps the random benchmark, no 0050 fetch")
    check(plots.get(name, 0) is None, f"{name}: pnl.png draws no 0050 line")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
