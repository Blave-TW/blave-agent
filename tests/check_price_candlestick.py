"""A coin's price in a report is a candlestick, never a line of closes (references/reports.md
› Price is drawn as a candlestick; design audit B8: XRP came out as an orange close line).

Runs lib/report_bricks.coin_snapshot on a stubbed kline fetch (no network) and checks the block.
Run: cd blave-agent && .venv/bin/python tests/check_price_candlestick.py
"""
import os, sys, types
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import lib.report_bricks as B  # noqa: E402

idx = pd.date_range("2026-05-01", periods=120, freq="D", tz="UTC")
close = pd.Series(np.linspace(0.5, 0.62, 120), index=idx)
df = pd.DataFrame({"Open": close * 0.99, "High": close * 1.02, "Low": close * 0.97, "Close": close,
                   "Volume": np.linspace(1e6, 2e6, 120)}, index=idx)
B._data.fetch_kline = lambda *a, **k: df.copy()
b = types.SimpleNamespace(headers={}, notes=[], missing=[], ctx={}, cache={})
brick = B.coin_snapshot(b, "XRP", days=30)
blocks = getattr(brick, "blocks", None) or getattr(brick, "items", None) or brick.__dict__.get("blocks") or []
types_ = [x.get("type") for x in blocks if isinstance(x, dict)]
ok = types_ == ["candlestick"] and len(blocks[0]["candles"]) == 90 and "近 90 根" in blocks[0]["caption"] and blocks[0]["y_unit"] == "USDT"
print(("PASS" if ok else "FAIL") + f"  coin_snapshot draws the price as a candlestick ({types_})")
sys.exit(0 if ok else 1)
