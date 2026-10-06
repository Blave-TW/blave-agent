"""lib/quality_check.py › _check_compute_signals — the "TEMPLATE stub logic was left unfilled"
WARNING. No network.

Must stay silent on a strategy whose position comes from a lib signal helper
(lib.strategy.threshold_position / hysteresis): the comparison is inside lib, the file has none of
its own. Fixture: the file the desktop agent wrote in the 2026-10-06 welcome-page e2e, verbatim —
the warning fired on it every time and showed as a failed step. Must still flag the shipped
templates untouched, a template that only imports a helper, and one that only wraps its empty
signal in apply_exits.
Run: cd blave-agent && .venv/bin/python tests/check_quality_template_helpers.py
"""
import ast, inspect, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import lib.exits, lib.strategy
from lib.quality_check import _SIGNAL_HELPERS, _check_compute_signals, check as full_check

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

def unfilled(src):
    return [f for f in _check_compute_signals(ast.parse(src)) if "left unfilled" in f["msg"]]

def swap(src, old, new):
    assert src.count(old) == 1, f"template anchor moved: {old!r}"
    return src.replace(old, new)

# verbatim: e2e-run3, 「跟我討論要怎麼用台指期日線做策略」 → 「1」
TXF_CHANNEL_TREND_1D = '''# Strategy: 台指期日線通道突破順勢
# Type:     A (single symbol, signal-based)
# Symbol:   TXF (台指期大台)
# Interval: 1d
# Logic:    120 日高低通道位置 > 0.9 做多、< 0.1 做空；多單跌破 0.4 出場、空單升破 0.6 出場；8% 停損；結算日前一棒平倉

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# ── Config ────────────────────────────────────────────────────────────────────
STRATEGY_NAME = "txf_channel_trend_1d"
DISPLAY_NAME  = "台指期日線通道突破順勢"
DESCRIPTION   = "台指期日線，120 日高低通道位置 > 0.9 做多、< 0.1 做空，多空各有出場門檻，另有 8% 停損並於結算日前平倉"
VERSION_NOTE  = ""
SYMBOL        = "TXF"
INTERVAL      = "1d"
START         = "1998-07-21"
END           = None
FEE           = 0.00015           # 單邊；1998 起指數低檔時佔比較高，取 0.015% 涵蓋全期間（税 0.002% + 手續費 + 1 tick）

CHANNEL  = 120      # 通道視窗（交易日，約半年）
BUY_TH   = 0.9      # 通道位置高於此值進多
SELL_TH  = 0.4      # 多單跌破此值出場
COVER_TH = 0.6      # 空單升破此值出場
SHORT_TH = 0.1      # 通道位置低於此值進空
STOP_PCT = 0.08     # 停損比例
WARMUP   = CHANNEL

PLOT_SERIES = {"通道位置": ("CHPOS", {"levels": {"進多": BUY_TH, "多出": SELL_TH, "空出": COVER_TH, "進空": SHORT_TH}})}


# ── indicators ────────────────────────────────────────────────────────────────
def _add_indicators(df, channel=CHANNEL):
    df = df.copy()
    hi = df['High'].rolling(channel).max()
    lo = df['Low'].rolling(channel).min()
    df['CHPOS'] = (df['Close'] - lo) / (hi - lo).replace(0.0, float('nan'))
    return df


# ── fetch_data ────────────────────────────────────────────────────────────────
def fetch_data(hdrs):
    from lib.data import fetch_twfutures_ohlcv
    df = fetch_twfutures_ohlcv(SYMBOL, '1d', START, END, hdrs)
    return _add_indicators(df)


# ── compute_signals ───────────────────────────────────────────────────────────
def compute_signals(df, channel=CHANNEL, buy_th=BUY_TH, sell_th=SELL_TH,
                    cover_th=COVER_TH, short_th=SHORT_TH, stop_pct=STOP_PCT):
    from lib.data import txf_settlement_mask
    from lib.exits import apply_exits
    from lib.strategy import threshold_position

    df     = _add_indicators(df, channel)
    signal = threshold_position(df['CHPOS'], buy_th, sell_th, cover_th, short_th)
    signal = apply_exits(signal, df, stop_pct=stop_pct, trigger="intrabar")

    settle = txf_settlement_mask(df.index)
    signal[settle] = 0.0
    return signal, settle


if __name__ == '__main__':
    from lib.runner import run
    from lib.notify import make_sender
    run(locals(), fetch_data, compute_signals, make_sender())
'''

# (a) the real file: no finding at all, and the CLI the agent runs says clean / exit 0
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "strategy.py")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(TXF_CHANNEL_TREND_1D)
    check(full_check(path) == [], "threshold_position + apply_exits strategy (e2e file, verbatim): no finding")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "lib", "quality_check.py"), "--context", "edit", path],
                       capture_output=True, text=True, encoding="utf-8")
    check(r.returncode == 0 and r.stdout.startswith("RESULT: clean\n"), "…and `--context edit` prints RESULT: clean, exit 0")

check(not unfilled("def compute_signals(df):\n    from lib.strategy import hysteresis\n"
                   "    return hysteresis(df['Z'], 1.5, 0.0)\n"), "hysteresis-only strategy: not flagged")
check(not unfilled("import lib.strategy as S\ndef compute_signals(df):\n"
                   "    return S.threshold_position(df['Z'], 1, 0, 0, -1)\n"), "module-qualified helper call: not flagged")

# (b) the shipped templates, untouched
TEMPLATE_A = open(os.path.join(ROOT, "strategies", "TEMPLATE_A.py"), encoding="utf-8").read()
TEMPLATE_C = open(os.path.join(ROOT, "strategies", "TEMPLATE_C.py"), encoding="utf-8").read()
check(len(unfilled(TEMPLATE_A)) == 1, "TEMPLATE_A untouched: flagged")
check(len(unfilled(TEMPLATE_C)) == 2, "TEMPLATE_C untouched: both NotImplementedError stubs flagged")

# (c) importing a helper is not calling it
imported = swap(TEMPLATE_A, "    import pandas as pd, numpy as np\n",
                "    import pandas as pd, numpy as np\n    from lib.strategy import threshold_position, hysteresis\n")
check(len(unfilled(imported)) == 1, "TEMPLATE_A + helper imported but never called: still flagged")

# (d) apply_exits on the template's all-NaN signal opens nothing — it is not signal logic
exits_only = swap(TEMPLATE_A, "    return signal\n",
                  "    from lib.exits import apply_exits\n"
                  "    return apply_exits(signal, df, stop_pct=0.03, trigger=\"intrabar\")\n")
check(len(unfilled(exits_only)) == 1, "TEMPLATE_A + apply_exits only: still flagged")

# The list is closed, so a new helper has to be classified here. lib/strategy.py and lib/exits.py
# are where strategy-code.md sends a strategy for these; their convention: a helper that makes a
# position takes the indicator `x` first, one that reshapes a position takes `signal` first.
makers, reshapers = set(), set()
for mod in (lib.strategy, lib.exits):
    for name, fn in inspect.getmembers(mod, inspect.isfunction):
        if fn.__module__ != mod.__name__ or name.startswith("_"):
            continue
        first = next(iter(inspect.signature(fn).parameters), None)
        (makers if first == "x" else reshapers if first == "signal" else set()).add(name)
check(makers == _SIGNAL_HELPERS, f"_SIGNAL_HELPERS is exactly lib's position-making helpers ({sorted(makers)})")
check(reshapers == {"apply_exits", "apply_vol_scaling", "clamp_spot"} and not reshapers & _SIGNAL_HELPERS,
      f"signal-reshaping helpers are known and none is in the list ({sorted(reshapers)})")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
