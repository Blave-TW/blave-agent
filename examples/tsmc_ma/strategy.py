# Strategy: 台積電 SMA 黃金交叉
# Type:     A (single symbol, signal-based)
# Symbol:   2330 (TSMC)
# Interval: 1d
# Logic:    快線 > 慢線 → 多；快線 < 慢線 → 出場

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# ── Config ────────────────────────────────────────────────────────────────────
STRATEGY_NAME = "tsmc_ma"
SYMBOL        = "2330"
INTERVAL      = "1d"
START         = "2015-01-01"
END           = None
FEE           = 0.003          # 單邊(per side):手續費 0.1425% ×2 + 證交稅 0.3%(賣方)平均 ≈ 0.29%

SMA_FAST = 5                   # 週線
SMA_SLOW = 60                  # 季線
WARMUP   = SMA_SLOW

PLOT_SERIES = {"SMA 5": ("SMA_F", {"overlay": True}), "SMA 60": ("SMA_S", {"overlay": True})}


# ── indicators ────────────────────────────────────────────────────────────────
def _add_indicators(df, fast=SMA_FAST, slow=SMA_SLOW):
    df = df.copy()
    df['SMA_F'] = df['Close'].rolling(fast).mean()
    df['SMA_S'] = df['Close'].rolling(slow).mean()
    return df


# ── fetch_data ────────────────────────────────────────────────────────────────
def fetch_data(hdrs):
    from lib.data import fetch_twstock_price_adj
    df = fetch_twstock_price_adj(SYMBOL, START, END, hdrs)
    return _add_indicators(df)


# ── compute_signals ───────────────────────────────────────────────────────────
def compute_signals(df, fast=SMA_FAST, slow=SMA_SLOW):
    import pandas as pd, numpy as np
    df = _add_indicators(df, fast, slow)
    f, s  = df['SMA_F'], df['SMA_S']
    golden = (f > s) & (f.shift(1) <= s.shift(1))
    death  = (f < s) & (f.shift(1) >= s.shift(1))
    signal = pd.Series(np.nan, index=df.index)
    signal[golden] = 1.0
    signal[death]  = 0.0
    # Seed the state on the bars before the first cross: a backtest that starts inside a
    # trend otherwise sits flat until the first cross (one seeded bar is dropped with WARMUP).
    pre = signal.ffill().isna() & f.notna() & s.notna()
    signal[pre] = (f > s)[pre].astype(float)
    return signal


if __name__ == '__main__':
    from lib.runner import run
    from lib.notify import make_sender
    run(locals(), fetch_data, compute_signals, make_sender())
