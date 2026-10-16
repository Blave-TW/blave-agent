"""Minimal check: lib/analysis.random_bh_benchmark(bands=False) — the blockwise path a Type C
live performance refresh takes — gives the same benchmark_* stats as the full T × n matrix, and
lib/runner asks for it exactly when no pnl.png is drawn (a live refresh: bands=False; a backtest,
quiet or not: bands=True). No network; the runner runs in a temp workspace on a copy of lib/.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_bench_blockwise.py
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from lib.analysis import random_bh_benchmark  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── 1. same stats, both paths ───────────────────────────────────────────────
rng = np.random.default_rng(3)
for T, S, n in ((2000, 4, 1000), (12000, 5, 1000), (9000, 2, 123), (400, 1, 50)):
    idx = pd.date_range("2024-01-01", periods=T, freq="5min")
    close = pd.DataFrame(np.cumprod(1 + rng.normal(0, 0.003, (T, S)), axis=0) * 100,
                         index=idx, columns=[f"S{i}" for i in range(S)])
    with contextlib.redirect_stdout(io.StringIO()):
        full, bands = random_bh_benchmark(close, 3.0, 0.4, n=n)
        lean, none = random_bh_benchmark(close, 3.0, 0.4, n=n, bands=False)
    check(full == lean and none is None and bands is not None and len(bands) == T,
          f"T={T} S={S} n={n}: blockwise stats identical, no bands")

# ── 2. the runner's choice, end to end ──────────────────────────────────────
BASE = tempfile.mkdtemp(prefix="bench-blockwise-")
WS = os.path.join(BASE, "ws")
os.makedirs(os.path.join(WS, "strategies", "cee"))
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
SRC = '''# Type: C
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import numpy as np
import pandas as pd
import lib.analysis as A
from lib.runner import run

_orig = A.random_bh_benchmark
def _spy(*a, **k):
    Path(__file__).with_name("bands.json").write_text(json.dumps(k.get("bands", True)))
    return _orig(*a, **k)
A.random_bh_benchmark = _spy

STRATEGY_NAME = "cee"
INTERVAL      = "1h"
START         = "2024-01-01"
FEE           = 0.0005


def fetch_data(hdrs):
    idx = pd.date_range("2024-01-01", periods=300, freq="h")
    t = np.arange(300)
    close = pd.DataFrame({"AAAUSDT": 100 + 5 * np.sin(t / 7.0), "BBBUSDT": 50 + 3 * np.cos(t / 11.0)}, index=idx)
    return pd.concat({"close": close, "open": close}, axis=1)


def compute(price_df):
    n = len(price_df)
    w = np.zeros((n, 2))
    w[np.arange(n) % 24 < 12, 0] = 0.5
    w[np.arange(n) % 24 >= 12, 1] = 0.5
    return w, price_df


run(locals(), fetch_data, compute)
'''
SDIR = os.path.join(WS, "strategies", "cee")
with open(os.path.join(SDIR, "strategy.py"), "w", encoding="utf-8") as f:
    f.write(SRC)


def run_mode(**env):
    r = subprocess.run([sys.executable, os.path.join(SDIR, "strategy.py")], cwd=WS,
                       env=dict(os.environ, PYTHONPATH=WS, **env), capture_output=True, text=True, timeout=180)
    with open(os.path.join(SDIR, "bands.json")) as f:
        bands = json.load(f)
    with open(os.path.join(SDIR, "stats.json")) as f:
        st = json.load(f)
    return r.returncode, bands, {k: v for k, v in st.items() if k.startswith("benchmark_")}


rc, b_bt, bench_bt = run_mode(BLAVE_MODE="backtest")
check(rc == 0 and b_bt is True and bench_bt, f"backtest: rc 0, full bands (pnl.png) ({rc}, {b_bt})")
rc, b_q, _ = run_mode(BLAVE_MODE="backtest", BLAVE_QUIET="1")
check(rc == 0 and b_q is True, f"quiet backtest (restore re-run) still draws pnl.png: bands ({rc}, {b_q})")
rc, b_rf, bench_rf = run_mode(BLAVE_MODE="live", BLAVE_STATS_REFRESH="1")
check(rc == 0 and b_rf is False, f"live performance refresh: bands=False ({rc}, {b_rf})")
check(bench_rf == bench_bt, f"refresh on the same data keeps every benchmark_* value ({len(bench_bt)} keys)")
check("benchmark_band" in bench_rf, "live performance refresh still writes benchmark_band (blockwise)")

shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
