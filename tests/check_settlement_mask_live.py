"""Minimal check: txf_settlement_mask marks the pre-settlement bar on the live tick too.

On a live tick that bar is the LAST bar. The loop used to stop at index.max(), so the
13:30 settlement right after it was never considered: the backtest (which sees the next
bar) went flat into settlement, live held through it. The loop now reaches one bar past
the last label — one bar, not one day, so an earlier tick does not flatten hours early.

Run: cd blave-agent && .venv/bin/python tests/check_settlement_mask_live.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pandas as pd

from lib.data import txf_settlement_mask

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


# 2025-03-19 is the third Wednesday: settlement 13:30 Taipei
day = pd.Timestamp("2025-03-19", tz="Asia/Taipei")
h60 = pd.DatetimeIndex([pd.Timestamp("2025-03-18", tz="Asia/Taipei") + pd.Timedelta(hours=h) for h in (9, 10, 11, 12, 13)]
                       + [day + pd.Timedelta(hours=h) for h in (9, 10, 11, 12, 13)]
                       + [pd.Timestamp("2025-03-20 09:00", tz="Asia/Taipei")])
settle_bar = day + pd.Timedelta(hours=13)

full = txf_settlement_mask(h60)
check(full[full].index.tolist() == [settle_bar], "backtest (next bar visible): 13:00 on settlement day marked, nothing else")
live = txf_settlement_mask(h60[h60 <= settle_bar])
check(bool(live.iloc[-1]), "live tick whose last bar is 13:00 on settlement day: marked")
early = txf_settlement_mask(h60[h60 <= day + pd.Timedelta(hours=12)])
check(not early.any(), "live tick at 12:00 on settlement day: not marked (one bar, not one day)")

m1 = pd.date_range(day + pd.Timedelta(hours=8, minutes=45), day + pd.Timedelta(hours=13, minutes=29), freq="1min")
check(bool(txf_settlement_mask(m1).iloc[-1]), "1m: live tick at 13:29 marked")
check(not txf_settlement_mask(m1[:-1]).any(), "1m: live tick at 13:28 not marked")

naive = h60.tz_convert("UTC").tz_localize(None)       # the kline cache's naive-UTC form
check(txf_settlement_mask(naive[naive <= settle_bar.tz_convert("UTC").tz_localize(None)]).iloc[-1],
      "naive-UTC index: same")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
