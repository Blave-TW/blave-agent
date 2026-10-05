# Strategy: BTC 均線趨勢（固定區間）
# Type:     A (single symbol, signal-based)
# Symbol:   BTCUSDT
# Market:   swap
# Interval: 4h
# Logic:    Long when SMA20 is above SMA60, flat otherwise

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# ── Config ────────────────────────────────────────────────────────────────────
STRATEGY_NAME = "gate_frozen_end"
DISPLAY_NAME  = "BTC 均線趨勢（固定區間）"
DESCRIPTION   = "BTC 四小時線均線趨勢，回測區間寫死。"
VERSION_NOTE  = ""
SYMBOL        = "BTCUSDT"
MARKET        = "swap"
INTERVAL      = "4h"
START         = "2025-09-01"
END           = "2026-03-01"
FEE           = 0.0005

SMA_FAST = 20
SMA_SLOW = 60
WARMUP   = SMA_SLOW


# ── indicators ────────────────────────────────────────────────────────────────
def _add_indicators(df, fast=SMA_FAST, slow=SMA_SLOW):
    df = df.copy()
    df['SMA_F'] = df['Close'].rolling(fast).mean()
    df['SMA_S'] = df['Close'].rolling(slow).mean()
    return df


# ── fetch_data ────────────────────────────────────────────────────────────────
def fetch_data(hdrs):
    from lib.data import fetch_kline
    df = fetch_kline(SYMBOL, INTERVAL, START, END, hdrs)
    return _add_indicators(df)


# ── compute_signals ───────────────────────────────────────────────────────────
def compute_signals(df, fast=SMA_FAST, slow=SMA_SLOW):
    import pandas as pd, numpy as np
    df     = _add_indicators(df, fast, slow)
    signal = pd.Series(np.nan, index=df.index)
    signal[df['SMA_F'] > df['SMA_S']] = 1.0
    signal[df['SMA_F'] < df['SMA_S']] = 0.0
    return signal


if __name__ == '__main__':
    from lib.runner import run
    from lib.notify import make_sender
    run(locals(), fetch_data, compute_signals, make_sender())
