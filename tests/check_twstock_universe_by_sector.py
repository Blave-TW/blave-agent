"""lib.strategy.twstock_universe_by_sector: the Taiwan universe drawn by industry.

  - ETFs (no industry_code) never enter; every industry is represented; len == total
  - same seed → same ids, whatever order the list arrives in
  - `industries` keeps only those codes ('5' and 5 match '05')
  - fewer slots than industries → one stock from each of `total` industries
  - it takes the list instead of fetching it: lib.strategy stays out of
    quality_check._LIB_REACHING_BLAVE (tests/check_blave_data_need.py)

No network. Run: .venv/bin/python tests/check_twstock_universe_by_sector.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pandas as pd  # noqa: E402

from lib.strategy import twstock_universe_by_sector  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += 0 if cond else 1


rows = []
for code, n in (("01", 3), ("05", 10), ("24", 60), ("25", 40), ("17", 20)):
    rows += [{"stock_id": f"{code}{k:02d}", "industry_code": code} for k in range(n)]
rows += [{"stock_id": f"00{k:02d}", "industry_code": None} for k in range(30)]
LIST = pd.DataFrame(rows).set_index("stock_id")

u = twstock_universe_by_sector(LIST, total=50)
code_of = LIST["industry_code"]
check(len(u) == 50 and len(set(u)) == 50, f"50 distinct ids ({len(u)})")
check(not any(s.startswith("00") for s in u), "no ETF")
check({code_of[s] for s in u} == {"01", "05", "24", "25", "17"}, "every industry represented")
check(sum(code_of[s] == "01" for s in u) == 3, "a small industry gives all it has, the rest is topped up")

shuffled = LIST.sample(frac=1, random_state=7)
check(twstock_universe_by_sector(shuffled, total=50) == u, "same seed, list in another order → same ids")
check(twstock_universe_by_sector(LIST, total=50, seed=1) != u, "another seed → another draw")

t = twstock_universe_by_sector(LIST, total=30, industries=["24", 5])
check(len(t) == 30 and {code_of[s] for s in t} == {"24", "05"}, f"industries filter, 5 matches '05' ({sorted({code_of[s] for s in t})})")
check(len(twstock_universe_by_sector(LIST, total=500)) == 133, "total above the pool → the whole pool")

few = twstock_universe_by_sector(LIST, total=3)
check(len(few) == 3 and len({code_of[s] for s in few}) == 3, "3 slots, 5 industries → 3 industries, one each")

try:
    twstock_universe_by_sector(LIST, total=10, industries=["99"])
    check(False, "an industry with no stocks raises")
except RuntimeError:
    check(True, "an industry with no stocks raises")

print("ALL OK" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
