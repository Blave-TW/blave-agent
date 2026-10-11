"""Minimal check: lib.data.fetch_tw_breadth_public / fetch_tw_sector_breadth — 上市漲跌家數 and
the per-industry split, counted from TWSE STOCK_DAY_ALL. No network: the day-all table and the
Blave stock list are fixed samples.

  - gate: without BLAVE_AGENT_LOCAL=1 both raise TwPublicUnavailable and make no request
  - filter: only 4-digit codes not starting with 0 are counted (ETF, 特別股, longer codes out)
  - a kept code with no close or no change is `untraded`, never flat
  - sectors: grouped by the list's industry_code ('5' and '05' are one group), 上櫃 rows of the
    list never appear, a stock the list has no industry for is `unclassified`, the average is
    the equal-weighted mean of change / (close - change)

Run: cd blave-agent && .venv/bin/python tests/check_tw_breadth.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pandas as pd
import requests

import lib.data as D

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def _no_network(*a, **k):
    raise AssertionError("network call in an offline check")


requests.Session.get = _no_network
requests.get = _no_network
NAN = float("nan")

# ── gate: a cloud machine gets an error, not a number ───────────────────────
os.environ.pop("BLAVE_AGENT_LOCAL", None)
for label, fn in (("breadth", D.fetch_tw_breadth_public), ("sector", lambda: D.fetch_tw_sector_breadth({}))):
    try:
        fn()
        check(False, f"{label}: cloud machine must raise")
    except D.TwPublicUnavailable:
        check(True, f"{label}: cloud machine raises TwPublicUnavailable before any request")

# ── fixed sample ────────────────────────────────────────────────────────────
ROWS = [  # stock_id, close, change
    ("2330", 110.0, 10.0),    # up  +10 %   半導體
    ("2454", 90.0, -10.0),    # down -10 %  半導體
    ("2303", 50.0, 0.0),      # flat        半導體
    ("1101", 21.0, 1.0),      # up  +5 %    水泥 (list says '1')
    ("1102", 42.0, 2.0),      # up  +5 %    水泥 (list says '01')
    ("9103", 9.0, -1.0),      # down, 4-digit DR: kept
    ("7777", 30.0, 3.0),      # up, not in the list → unclassified
    ("2888", NAN, NAN),       # no trade
    ("2889", 12.0, NAN),      # close but no change → untraded, not flat
    ("0050", 200.0, 5.0),     # ETF
    ("00878", 22.0, 0.1),     # ETF, 5 digits
    ("2881A", 60.0, 0.5),     # 特別股
    ("020011", 5.0, 0.2),     # longer code
    ("911608", 3.0, -0.1),    # 6-digit DR
]
DAY = pd.DataFrame([{"stock_id": s, "name": s, "value": 1e8, "volume": 1e6, "close": c, "change": ch, "trades": 10.0}
                    for s, c, ch in ROWS]).set_index("stock_id")
DAY.attrs = {"date": "2026-09-24", "source": D._TWSE_OPENDATA_SOURCE_ZH}
LIST = pd.DataFrame({"name": "x", "industry_code": ["24", "24", "24", "1", "01", "91", NAN, "24", "24", NAN, "24"]},
                    index=pd.Index(["2330", "2454", "2303", "1101", "1102", "9103", "0050", "2888", "2889", "7777",
                                    "6488"], name="stock_id"))   # 6488: 上櫃, in the list only
D.fetch_twse_day_all_public = lambda: DAY.copy()
D.fetch_twstock_list = lambda h, **k: LIST.copy()

b = D.fetch_tw_breadth_public()
check((b["up"], b["down"], b["flat"]) == (4, 2, 1), f"up/down/flat = 4/2/1 — got {b['up']}/{b['down']}/{b['flat']}")
check(b["total"] == 7 and b["untraded"] == 2, f"total 7, untraded 2 — got {b['total']}, {b['untraded']}")
check(b["date"] == "2026-09-24" and b["source"] == D._TWSE_OPENDATA_SOURCE_ZH, "date and attribution carried")

s = D.fetch_tw_sector_breadth({})
check(list(s.index) == ["01", "24", "91"], f"sectors, best average first — got {list(s.index)}")
check(list(s["name"]) == ["水泥工業", "半導體業", "存託憑證"], f"names — got {list(s['name'])}")
check(s.loc["24", ["up", "down", "flat"]].tolist() == [1, 1, 1], "半導體 1/1/1 (untraded 2888 / 2889 not counted)")
check(s.loc["01", ["up", "down", "flat"]].tolist() == [2, 0, 0], "'1' and '01' are one 水泥 group, 2/0/0")
check(s.loc["91", ["up", "down", "flat"]].tolist() == [0, 1, 0], "存託憑證 0/1/0")
want = {"01": 5.0, "24": (10 / 100 - 10 / 100 + 0) / 3 * 100, "91": -10.0}
check(all(abs(s.loc[k, "avg_change_pct"] - v) < 1e-9 for k, v in want.items()),
      f"average change = mean of change / prev — got {s['avg_change_pct'].round(4).to_dict()}")
check(int(s[["up", "down", "flat"]].sum().sum()) + s.attrs["unclassified"] == b["total"] and s.attrs["unclassified"] == 1,
      f"sector rows + unclassified (7777) = breadth total — unclassified {s.attrs['unclassified']}")
check(s.attrs["date"] == "2026-09-24" and s.attrs["source"] == D._TWSE_OPENDATA_SOURCE_ZH, "sector attrs carried")

D.fetch_twstock_list = lambda h, **k: pd.DataFrame()
e = D.fetch_tw_sector_breadth({})
check(e.empty and e.attrs["unclassified"] == 7, "empty stock list → empty frame, every stock unclassified")

print("all checks passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
