"""Minimal check: lib.analysis.bh_benchmark writes `sharpe_ratio` on the same per-bar basis as the
strategy's own Sharpe (compute_stats on per-bar returns — an hourly backtest is not resampled
to days first; api/openclaw/marketplace._benchmark_from_stats reads `sharpe_ratio`); a Type A
backtest writes no `benchmark_bh` key — shipped surfaces read its presence as "Type C".

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_bh_benchmark_sharpe.py
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

import lib.runner as runner
from lib.analysis import bh_benchmark, compute_stats
import strategy_reporter as sr  # noqa: E402

runner.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


WS = Path(tempfile.mkdtemp(prefix="bh-sharpe-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
os.environ["BLAVE_MODE"] = "backtest"

rng = np.random.default_rng(11)
IDX = pd.date_range("2025-01-01", periods=24 * 120, freq="h")
PX = 100 * np.exp(np.cumsum(rng.normal(0.0002, 0.01, len(IDX))))
DF = pd.DataFrame({"Open": PX, "High": PX * 1.002, "Low": PX * 0.998, "Close": PX, "Volume": 1.0}, index=IDX)
bar_ret = np.r_[0.0, PX[1:] / PX[:-1] - 1]
want_sharpe, _, _, want_mdd, want_ann = compute_stats(bar_ret, IDX)

# ── bh_benchmark: Sharpe per bar, like the strategy's ──
st_bh, _ = bh_benchmark(pd.Series(PX, index=IDX), DF, "X_bh", "X", adjusted=False)
daily = pd.Series(PX, index=IDX).resample("1D").last()
daily_sharpe = compute_stats(daily.pct_change().fillna(0).values, daily.index)[0]
check(isinstance(st_bh.get("sharpe_ratio"), float) and math.isclose(st_bh["sharpe_ratio"], round(want_sharpe, 4), abs_tol=1e-9),
      f"bh_benchmark sharpe_ratio = compute_stats on per-bar returns, 4 dp ({st_bh.get('sharpe_ratio')} vs {want_sharpe:.4f})")
check(abs(want_sharpe - daily_sharpe) > 1e-3, f"(the test separates per-bar from daily: {want_sharpe:.4f} vs {daily_sharpe:.4f})")
flat, _ = bh_benchmark(pd.Series(100.0, index=IDX), DF, "X_bh", "X", adjusted=False)
check(flat.get("sharpe_ratio") == 0.0, f"a flat benchmark has Sharpe 0, never NaN ({flat.get('sharpe_ratio')})")


def signals(df):
    return pd.Series(np.where(df["Close"] > df["Close"].rolling(48).mean(), 1.0, 0.0), index=df.index)


def run(name, src, symbol="BTCUSDT"):
    d = WS / "strategies" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "strategy.py").write_text(src)
    cfg = {"STRATEGY_NAME": name, "SYMBOL": symbol, "INTERVAL": "1h", "START": "2025-01-01",
           "FEE": 0.0005, "MCPT": False, "__file__": str(d / "strategy.py")}
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        runner.run(cfg, lambda h: DF.copy(), signals)
    return json.loads((d / "stats.json").read_text())


def src(fetcher, sym="BTCUSDT"):
    return (f'from lib.data import {fetcher}\nSYMBOL = "{sym}"\n# Type A\n\n\n'
            f'def fetch_data(hdrs):\n    return {fetcher}("{sym}", "1h", "2025-01-01", "2025-05-01", hdrs)\n')


# ── Type A writes no benchmark_bh: the desktop export menu / trades tab (shell export.js, report-trades.js) and
# the web workspace xpOff read the key's presence as "Type C" — a Type A carrying it loses Pine / XQ export ──
TXF_MASK = "\n\ndef compute_signals(df):\n    return txf_settlement_mask(df.index)\n"   # the runner refuses TAIFEX without it
for name, s, sym, why in (("ta_crypto", src("fetch_kline"), "BTCUSDT", "crypto"), ("ta_us", src("fetch_usstock_price", "NVDA"), "NVDA", "US stock"),
                          ("ta_tw_adj", src("fetch_twstock_price_adj", "2330"), "2330", "Taiwan adjusted close"),
                          ("ta_txf", src("fetch_twfutures_ohlcv", "TXF") + TXF_MASK, "TXF", "TXF"), ("ta_nosym", src("fetch_kline"), None, "no SYMBOL")):
    st = run(name, s, symbol=sym)
    check("benchmark_bh" not in st and isinstance(st.get("Benchmark Return [%]"), (int, float)),
          f"Type A {why}: no benchmark_bh key, Benchmark Return [%] as before")
    check(not sr.is_portfolio_stats(st), f"Type A {why}: not a portfolio")

print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
