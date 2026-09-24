"""Minimal check: the bar that has not closed yet never reaches a strategy's signal.

Blave /kline resamples closed 1m/5m base bars into the requested period and keeps the
partial last bucket; Binance and BingX klines always include the open candle. Inside
lib.data.closed_bars_only() — which the runner and wait_for_bar wrap around fetch_data —
the crypto kline fetchers drop it. Outside the scope nothing changes (paper fills, reports,
the drift-band sigma keep their current-price reads). No network: the cache layer is stubbed.

  - _drop_forming_bar: label + interval > now dropped; closed bar kept; naive and tz-aware
    index; weekly / unparseable intervals untouched; no-op outside the scope
  - fetch_kline / fetch_kline_batch / fetch_bingx_kline honour the scope
  - wait_for_bar's freshness check reports the last CLOSED bar, not the forming one
  - a live tick's state.json position comes from the last closed bar

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_kline_forming_bar.py
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
from datetime import datetime, timezone
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")

import dotenv
dotenv.dotenv_values = lambda *a, **k: {}   # never read the workspace .env

import numpy as np
import pandas as pd

import lib.data as D
import lib.runner as runner

runner.dotenv_values = dotenv.dotenv_values

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def bars(end_label, n=300, freq="1h", tz=None):
    idx = pd.date_range(end=end_label, periods=n, freq=freq, tz=tz)
    c = 100 + np.arange(n, dtype=float)
    return pd.DataFrame({"Open": c, "High": c + 1, "Low": c - 1, "Close": c, "Volume": 1.0}, index=idx)


NOW = pd.Timestamp("2026-09-23 10:32")                 # naive UTC, like the kline cache
df = bars("2026-09-23 10:00")                           # 10:00 = the forming bar
with D.closed_bars_only():
    got = D._drop_forming_bar(df, "1h", now=NOW)
check(got.index[-1] == pd.Timestamp("2026-09-23 09:00"), f"1h: forming 10:00 dropped, 09:00 kept ({got.index[-1]})")
check(D._drop_forming_bar(df, "1h", now=NOW).index[-1] == pd.Timestamp("2026-09-23 10:00"),
      "outside closed_bars_only(): unchanged")
with D.closed_bars_only():
    aware = D._drop_forming_bar(bars("2026-09-23 10:00", tz="UTC"), "1h", now=NOW.tz_localize("UTC"))
    exact = D._drop_forming_bar(bars("2026-09-23 09:00"), "1h", now=pd.Timestamp("2026-09-23 10:00"))
    fivem = D._drop_forming_bar(bars("2026-09-23 10:30", freq="5min"), "5min", now=NOW)
    weekly = D._drop_forming_bar(bars("2026-09-20", freq="7D"), "1w", now=NOW)
    odd = D._drop_forming_bar(df, "1M", now=NOW)
check(aware.index[-1] == pd.Timestamp("2026-09-23 09:00", tz="UTC"), "tz-aware index: same cut")
check(exact.index[-1] == pd.Timestamp("2026-09-23 09:00"), "a bar that closes exactly now is kept")
check(fivem.index[-1] == pd.Timestamp("2026-09-23 10:25"), f"5min: 10:30 forming dropped ({fivem.index[-1]})")
check(len(weekly) == 300 and len(odd) == 300, "weekly / unparseable interval untouched")

# ── the fetchers, with the cache layer stubbed to hand back a frame ending on a forming bar ──
now_floor = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("1h")
live_df = bars(now_floor)                               # last row = the hour now in progress
D._extend_cache_monthly = lambda prefix, params, fn, start, end, **k: live_df.copy()
D._fetch_batch_cached = lambda *a, **k: {"BTCUSDT": live_df.copy()}
with D.closed_bars_only():
    k1 = D.fetch_kline("BTCUSDT", "1h", "2026-01-01", None, {})
    kb = D.fetch_kline_batch(["BTCUSDT"], "1h", "2026-01-01", None, {})["BTCUSDT"]
    kx = D.fetch_bingx_kline("BTC-USDT", "1h", "2026-01-01", None)
k0 = D.fetch_kline("BTCUSDT", "1h", "2026-01-01", None, {})
closed = now_floor - pd.Timedelta("1h")
check(k1.index[-1] == kb.index[-1] == kx.index[-1] == closed,
      "fetch_kline / fetch_kline_batch / fetch_bingx_kline drop the forming bar in scope")
check(k0.index[-1] == now_floor, "…and return it unchanged outside the scope")

# ── wait_for_bar: the freshness probe sees the last closed bar ────────────────────
spec = importlib.util.spec_from_file_location("wfb", os.path.join(ROOT, "manager", "wait_for_bar.py"))
wfb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfb)
mod = types.SimpleNamespace(fetch_data=lambda h: D.fetch_kline("BTCUSDT", "1h", "2026-01-01", None, h))
expected = wfb._expected_closed_bar_open("1h", datetime.now(timezone.utc).replace(tzinfo=None))
seen, ready, _ = wfb._check_freshness(mod, expected)
check(seen == expected and ready, f"wait_for_bar: observed = last closed bar {expected} (got {seen})")

# ── live tick: position comes from the last closed bar ────────────────────────────
WS = Path(tempfile.mkdtemp(prefix="forming-", dir=os.environ.get("SCRATCHPAD") or None))
os.chdir(WS)
runner._REPO_ROOT = WS
STATE = WS / "strategies" / "formcheck" / "state.json"
STATE.parent.mkdir(parents=True)
STATE.write_text(json.dumps({"position": 0.0}))


def fetch(h):
    from lib.data import fetch_kline
    return fetch_kline("BTCUSDT", "1h", "2026-01-01", None, h)


def compute(d):                                        # the forming bar would flip it long
    sig = pd.Series(0.0, index=d.index)
    sig[d.index == now_floor] = 1.0
    return sig


os.environ["BLAVE_MODE"] = "live"
with contextlib.redirect_stdout(io.StringIO()):
    runner.run({"STRATEGY_NAME": "formcheck", "SYMBOL": "BTCUSDT", "INTERVAL": "1h",
                "START": "2026-01-01", "FEE": 0.0005}, fetch, compute)
pos = json.loads(STATE.read_text())["position"]
check(pos == 0.0, f"live tick: the forming bar's signal is not traded (position {pos})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
