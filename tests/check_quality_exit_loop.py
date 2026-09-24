"""lib/quality_check.py › _check_exit_loop — the WARNING for a hand-written exit loop. No network.

Flagged: a per-bar loop that assigns an entry price and compares it (or a level derived from it)
with a stop / target. Cleared by any lib.exits.apply_exits call. Must flag the 29026
e2e_exit_test file (verbatim, 2026-09-23 agent test) and the 2026-09-23 e2e_0923_ma no-op stop;
must stay silent on every shipped template / example and on loops that only look similar.
The runner prints the same warning after a backtest (lib/runner.py) and never blocks the run.
Run: cd blave-agent && .venv/bin/python tests/check_quality_exit_loop.py
"""
import ast, glob, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib.quality_check import _check_exit_loop, check as full_check

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

def flags(src):
    return _check_exit_loop(ast.parse(src))

# verbatim: the file the agent wrote on 29026 for "EMA20/50 cross + 3% stop + 6% take-profit"
E2E_EXIT_TEST_29026 = '''# Strategy: BTC 1h EMA20/50 交叉 + 固定停損停利
# Type:     A (single symbol, signal-based)
# Symbol:   BTCUSDT
# Market:   swap
# Interval: 1h
# Logic:    EMA20 上穿 EMA50 做多；EMA20 下穿 EMA50、或觸及 3% 停損 / 6% 停利，平倉出場。

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# ── Config ────────────────────────────────────────────────────────────────────
STRATEGY_NAME = "e2e_exit_test"
DISPLAY_NAME  = "BTC 1 小時 EMA20/50 交叉（含停損停利）"
DESCRIPTION   = "BTC 永續合約 1 小時線 EMA20 上穿 EMA50 做多，下穿平倉，並加 3% 停損、6% 停利。"
VERSION_NOTE  = "建立 BTC 1h EMA20/50 交叉基準回測，含 3% 停損 / 6% 停利"
SYMBOL        = "BTCUSDT"
MARKET        = "swap"
INTERVAL      = "1h"
START         = "2025-09-23"
END           = None
FEE           = 0.0005            # Binance USDT-M perp taker ≈ 0.05%

EMA_FAST = 20
EMA_SLOW = 50
WARMUP   = EMA_SLOW

SL_PCT = 0.03   # 停損：進場價下跌 3% 出場
TP_PCT = 0.06   # 停利：進場價上漲 6% 出場

PLOT_SERIES = {
    "EMA fast": ("EMA_F", {"overlay": True}),
    "EMA slow": ("EMA_S", {"overlay": True}),
}


# ── indicators ────────────────────────────────────────────────────────────────
def _add_indicators(df, fast=EMA_FAST, slow=EMA_SLOW):
    df = df.copy()
    df["EMA_F"] = df["Close"].ewm(span=fast, adjust=False).mean()
    df["EMA_S"] = df["Close"].ewm(span=slow, adjust=False).mean()
    return df


# ── fetch_data ────────────────────────────────────────────────────────────────
def fetch_data(hdrs):
    from lib.data import fetch_kline

    df = fetch_kline(SYMBOL, INTERVAL, START, END, hdrs)
    return _add_indicators(df)


# ── compute_signals ───────────────────────────────────────────────────────────
# SL/TP need the actual entry price and this bar's High/Low, which a vectorized
# threshold comparison can't express — so position state is tracked bar by bar.
# Execution is next-bar Open (Signal Contract), so entry_price is set to Open
# only once a prior 1.0/0.0 signal actually takes effect at the start of a bar.
def compute_signals(df):
    import numpy as np
    import pandas as pd

    fast, slow = df["EMA_F"], df["EMA_S"]
    golden = (fast > slow) & (fast.shift(1) <= slow.shift(1))
    death = (fast < slow) & (fast.shift(1) >= slow.shift(1))

    opens, highs, lows = df["Open"].values, df["High"].values, df["Low"].values
    golden_v, death_v = golden.values, death.values

    signal = np.full(len(df), np.nan)
    position = 0          # 0 = flat, 1 = long
    entry_price = None
    prev_signal = np.nan  # signal decided on the previous bar, applied at this bar's Open

    for i in range(len(df)):
        if not np.isnan(prev_signal):
            if prev_signal >= 1.0 and position == 0:
                position = 1
                entry_price = opens[i]
            elif prev_signal == 0.0 and position == 1:
                position = 0
                entry_price = None

        if position == 1:
            sl_price = entry_price * (1 - SL_PCT)
            tp_price = entry_price * (1 + TP_PCT)
            if lows[i] <= sl_price or highs[i] >= tp_price:
                signal[i] = 0.0
            elif death_v[i]:
                signal[i] = 0.0
            else:
                signal[i] = np.nan
        else:
            signal[i] = 1.0 if golden_v[i] else np.nan

        prev_signal = signal[i]

    return pd.Series(signal, index=df.index)


if __name__ == "__main__":
    from lib.notify import make_sender
    from lib.runner import run

    run(locals(), fetch_data, compute_signals, make_sender())
'''

# the 2026-09-23 e2e_0923_ma stop that re-entered on the same bar (0 of 8,770 bars changed)
E2E_0923_MA = """
SL_PCT = 0.03
def compute_signals(df, sl_pct=SL_PCT):
    close, ma_f, ma_s = df['Close'].tolist(), df['MA_F'].tolist(), df['MA_S'].tolist()
    out, pos, entry_price = [0] * len(df), 0, None
    for i in range(len(df)):
        f, s, c = ma_f[i], ma_s[i], close[i]
        if pos == 1:
            if c <= entry_price * (1 - sl_pct) or f < s:
                pos = 0
                entry_price = None
        if pos == 0 and f > s:
            pos = 1
            entry_price = c
        out[i] = pos
    return out
"""

SHORT_TP_EP = """
TAKE_PROFIT = 0.05
def compute_signals(df):
    sig, pos, ep = [], 0, 0.0
    for c in df['Close']:
        if pos == -1 and c <= ep * (1 - TAKE_PROFIT):
            pos = 0
        elif pos == 0:
            pos, ep = -1, c
        sig.append(pos)
    return sig
"""

POSITIVES = {
    "29026 e2e_exit_test (SL/TP on High/Low vs entry_price)": E2E_EXIT_TEST_29026,
    "2026-09-23 e2e_0923_ma same-bar re-entry stop": E2E_0923_MA,
    "short take-profit, entry named `ep`, level inline": SHORT_TP_EP,
}
for label, src in POSITIVES.items():
    f = flags(src)
    check(len(f) == 1 and f[0]["level"] == "WARNING", f"flagged as a WARNING: {label}")
f = flags(E2E_EXIT_TEST_29026)[0]
check("apply_exits" in f["msg"] and "trigger=" in f["msg"] and "tell the user" in f["msg"],
      "the message says: apply_exits(trigger=...), or tell the user what it can't model")
check(f["line"] == E2E_EXIT_TEST_29026.splitlines().index(
          "            if lows[i] <= sl_price or highs[i] >= tp_price:") + 1,
      f"points at the SL/TP comparison line ({f['line']})")

# the same file through the CLI entry point: a warning, never CRITICAL (not a block)
import tempfile
with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as t:
    t.write(E2E_EXIT_TEST_29026)
full = full_check(t.name)
os.unlink(t.name)
check(any("hand-written exit loop" in x["msg"] for x in full) and all(x["level"] == "WARNING" for x in full),
      "check() reports it as a WARNING and nothing CRITICAL (exit 1, not 2)")

NEGATIVES = {
    "same strategy using apply_exits": E2E_EXIT_TEST_29026.replace(
        "    return pd.Series(signal, index=df.index)",
        "    from lib.exits import apply_exits\n    return apply_exits(pd.Series(signal, index=df.index), df, stop_pct=SL_PCT, trigger=\"intrabar\")"),
    "four-threshold state machine loop (no entry price)": """
def compute_signals(df):
    x, pos, out = df['z'].to_numpy(), 0, []
    for v in x:
        if pos == 1 and v < SELL_TH: pos = 0
        if pos == -1 and v > COVER_TH: pos = 0
        if pos == 0 and v > BUY_TH: pos = 1
        if pos == 0 and v < SHORT_TH: pos = -1
        out.append(pos)
    return out
""",
    "`entry` as a boolean signal inside a loop": """
def compute_signals(df):
    out = []
    for i in range(len(df)):
        entry = df['z'].iat[i] > ENTRY_TH
        exit_ = df['z'].iat[i] < EXIT_TH
        out.append(1.0 if entry else (0.0 if exit_ else float('nan')))
    return out
""",
    "entry price tracked only for a win count (no stop / target)": """
def compute_signals(df):
    wins, pos, entry_price = 0, 0, None
    for i, c in enumerate(df['Close']):
        if pos and c / entry_price - 1 > 0:
            wins += 1
        entry_price = c
    return df['Close'] * 0
""",
    "entry price vs a slow MA (`slow` is not `sl`)": """
def compute_signals(df):
    out, entry_price, ma_slow = [], None, df['MA_SLOW'].to_numpy()
    for i in range(len(df)):
        entry_price = df['Open'].iat[i]
        out.append(1.0 if entry_price > ma_slow[i] else 0.0)
    return out
""",
    "ATR trailing stop without an entry price (txf_composite_60m leg 1 shape)": """
def compute_signals(df):
    pos, stop, out = 0, -1e9, []
    for i in range(len(df)):
        if pos == 1 and close[i] < stop: pos = 0
        if pos == 0 and close[i] > entry_hi[i]:
            pos, stop = 1, close[i] - ATR_K * atr[i]
        out.append(pos)
    return out
""",
}
for label, src in NEGATIVES.items():
    check(not flags(src), f"not flagged: {label}")

shipped = sorted(glob.glob(os.path.join(ROOT, "strategies", "TEMPLATE_*.py"))
                 + glob.glob(os.path.join(ROOT, "examples", "*", "*.py")))
noisy = [os.path.relpath(p, ROOT) for p in shipped
         if flags(open(p, encoding="utf-8").read())]
check(len(shipped) >= 10 and not noisy, f"no shipped template / example is flagged ({len(shipped)} files; {noisy})")

# ── backtest time: run() prints the WARNING line and still finishes; a clean file prints nothing
import json, shutil, subprocess
SYNTH = """def fetch_data(hdrs):
    import numpy as np, pandas as pd
    idx = pd.date_range("2025-01-01", periods=600, freq="h", tz="UTC")
    c = 100 * np.exp(np.cumsum(np.random.default_rng(3).normal(0, 0.01, 600)))
    df = pd.DataFrame({"Open": c, "High": c * 1.004, "Low": c * 0.996, "Close": c, "Volume": 1.0}, index=idx)
    return _add_indicators(df)
"""
REAL_FETCH = E2E_EXIT_TEST_29026[E2E_EXIT_TEST_29026.index("def fetch_data(hdrs):"):
                                 E2E_EXIT_TEST_29026.index("# ── compute_signals")]
flagged_src = E2E_EXIT_TEST_29026.replace(REAL_FETCH, SYNTH + "\n\n")
clean_src = NEGATIVES["same strategy using apply_exits"].replace(REAL_FETCH, SYNTH + "\n\n")
WS = tempfile.mkdtemp(prefix="exit-loop-runner-")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"), ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "strategies", "e2e_exit_test"))

def backtest(src):
    path = os.path.join(WS, "strategies", "e2e_exit_test", "strategy.py")
    open(path, "w", encoding="utf-8").write(src)
    stats = os.path.join(WS, "strategies", "e2e_exit_test", "stats.json")
    if os.path.exists(stats):
        os.unlink(stats)
    r = subprocess.run([sys.executable, "strategies/e2e_exit_test/strategy.py"], cwd=WS, capture_output=True,
                       text=True, timeout=300, env=dict(os.environ, BLAVE_MODE="backtest"))
    return r.returncode, r.stdout, os.path.exists(stats)

rc, out, wrote = backtest(flagged_src)
check(rc == 0 and wrote, f"e2e_exit_test shape: the backtest still finishes and writes stats.json (rc={rc})")
check(any(l.strip().startswith("⚠️ WARNING: hand-written exit loop") for l in out.splitlines()),
      "…and prints a `⚠️ WARNING: hand-written exit loop` line in the backtest output")
rc, out, wrote = backtest(clean_src)
check(rc == 0 and wrote and "hand-written exit loop" not in out,
      f"the same strategy on apply_exits: finishes, no exit-loop warning (rc={rc})")
shutil.rmtree(WS)

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
