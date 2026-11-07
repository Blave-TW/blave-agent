"""Minimal check for the full-history chart export in lib/runner.py (_write_chart_dir and the
untruncated _build_candles / _build_panes it is fed):
  - bars under 5 minutes keep CHART_SUB5_MAX_CHUNKS chunks, others CHART_MAX_CHUNKS, and
    CHART_SUB5_MAX_CHUNKS is the shell renderer's SUB5_MAX_BARS in chunks (+1 partial newest);
  - the column-wise build gives the same numbers as the per-bar tail path, timestamps included
    (s / ms / us / ns units, tz-aware, a fractional second);
  - whole prices and volumes are written without '.0', other values exactly as before.
Run: cd blave-agent && .venv/bin/python tests/check_chart_export.py
"""
import json, os, re, shutil, sys, tempfile
from pathlib import Path
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import numpy as np
import pandas as pd
import lib.runner as R

fails = 0
def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg); fails += (not cond)

js = open(os.path.join(ROOT, "shell", "renderer", "report-trades.js"), encoding="utf-8").read()
sub5_bars = int(re.search(r"const SUB5_MAX_BARS = (\d+);", js).group(1))
check(R.CHART_SUB5_MAX_CHUNKS == sub5_bars // R.CHART_CHUNK_BARS + 1,
      f"CHART_SUB5_MAX_CHUNKS {R.CHART_SUB5_MAX_CHUNKS} = renderer {sub5_bars} bars / {R.CHART_CHUNK_BARS} + 1")

rng = np.random.default_rng(0)
n = 3000
c = 20000 + np.cumsum(rng.integers(-3, 4, n)).astype(float)
df = pd.DataFrame({"Open": c, "High": c + 2, "Low": c - 2, "Close": c.copy(),
                   "Volume": rng.integers(1, 50, n).astype(float), "x": c / 7.0},
                  index=pd.date_range("2025-01-01", periods=n, freq="1min"))
df.iloc[rng.choice(n, 40), 1] = np.nan
df.iloc[:20, 5] = np.nan                       # a rolling indicator's warmup
df.iloc[[100, 200], 5] = [np.inf, -np.inf]
obj_vals = list(c / 3.0)
obj_vals[50], obj_vals[60] = float("nan"), float("inf")
plot = {"x": "x", "obj": pd.Series(obj_vals, index=df.index, dtype=object)}

# same numbers as the per-bar path (the capped tail with k ≥ n walks every bar)
full_c, full_p = R._build_candles(df, None), R._build_panes(plot, df, max_points=None)
check(full_c == R._build_candles(df, n + 1) and len(full_c) == n - 40, "candles: column-wise == per-bar, bad bars dropped")
check(full_p == R._build_panes(plot, df, max_points=n + 1), "panes: column-wise == per-bar (float and numeric-object series)")
check([len(p["points"]) for p in full_p] == [n - 22, n - 2] and "NaN" not in json.dumps(full_p) and "Infinity" not in json.dumps(full_p),
      "panes: NaN / inf points dropped (JSON.parse in the shell and web would refuse the whole chunk)")
mixed = pd.Series(([None, "x", "1.5", np.nan, 3] * n)[:n], index=df.index, dtype=object)
check(R._build_panes({"m": mixed}, df, max_points=None) == R._build_panes({"m": mixed}, df, max_points=n + 1),
      "panes: a series with a stray string still goes per element")
for unit in ("s", "ms", "us", "ns"):
    idx = pd.DatetimeIndex(df.index.astype(f"datetime64[{unit}]"))
    check(R._index_ts(idx) == [int(t.timestamp()) for t in idx], f"_index_ts unit {unit}")
for idx in (df.index.tz_localize("Asia/Taipei"), df.index + pd.Timedelta("500ms")):
    check(R._index_ts(idx) == [int(t.timestamp()) for t in idx], f"_index_ts {idx.tz or 'fractional second'}")

# whole numbers without '.0'; the rest unchanged
raw = json.dumps(full_c[:5])
check(".0," not in raw and ".0]" not in raw and all(type(v) is int for v in full_c[0][1:]), f"whole prices/volumes as int: {raw[:80]}")
odd = df.assign(Open=df["Open"] + 0.25, Volume=df["Volume"] / 3.0)
oc = R._build_candles(odd, None)
check(oc[0][1] == round(float(odd["Open"].iloc[0]), 6) and type(oc[0][1]) is float
      and oc[0][5] == float(odd["Volume"].iloc[0]) and type(oc[0][5]) is float, "non-whole values stay floats as before")
check(R._build_candles(df, 7) == full_c[-7:] and type(R._build_candles(df, 7)[0][1]) is float,
      "stats.json tail keeps its float format")

# chunk cap by interval
R.CHART_CHUNK_BARS = 100  # 3000 bars → 30 chunks
tmp = Path(tempfile.mkdtemp())
try:
    for i, (interval, want) in enumerate((("1min", R.CHART_SUB5_MAX_CHUNKS), ("1m", R.CHART_SUB5_MAX_CHUNKS),
                                          ("5min", 30), ("1h", 30), ("1M", 30))):
        out = tmp / str(i)  # not the interval: '1m' and '1M' are one folder on macOS / Windows
        out.mkdir()
        m = R._write_chart_dir(out, df, full_c, full_p, [], "TXF", interval)
        got = len(list((out / "chart").glob("chunk-*.json")))
        check(len(m["chunks"]) == got == want and m["truncated"] == (want < 30)
              and m["chunks"][-1]["t1"] == int(df.index[-1].timestamp()),
              f"{interval}: {got} chunks kept (want {want}), newest last, truncated={m['truncated']}")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print("all checks passed" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
