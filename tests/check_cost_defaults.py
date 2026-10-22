"""Per-market default FEE (lib/costs) and paper charging the same rate as the backtest. No network.

  1. one assertion per market default (Wei 2026-10-22: per side, slippage included);
  2. default_fee: Type C universe takes the highest member, `fees=` overrides one call;
  3. order_paper._fee_rate gives the backtest's rate: the market default when no strategy
     covers the symbol, the strategy's own FEE when one does;
  4. runner._default_fee: a strategy without FEE gets its market default.
Run: cd blave-agent && .venv/bin/python tests/check_cost_defaults.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib.costs import DEFAULT_FEES, default_fee, is_tw_etf

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

# 1
check(default_fee("2330") == 0.005, "TW stock 0.5%")
check(default_fee("6488.TWO") == 0.005, "TPEx stock 0.5%")
check(default_fee("0050") == 0.003 and default_fee("00679B") == 0.003 and is_tw_etf("00679B"),
      "TW ETF (bond ETF included) 0.3%")
check(default_fee("BTCUSDT") == 0.001 and default_fee("NVDAUSDT", "swap") == 0.001, "crypto perp 0.1%")
check(default_fee("BTCUSDT", "spot") == 0.0015, "crypto spot 0.15%")
check(all(default_fee(s) == 0.0001 for s in ("TXF", "MXF", "TMF", "TXFR1")), "TAIFEX index futures 0.01%")
check(default_fee("AAPL") is None and default_fee("CL") is None and default_fee("CDF") is None,
      "uncovered markets → None")
# 2
check(default_fee(universe=["0050", "00878"]) == 0.003, "ETF universe 0.3%")
check(default_fee(universe=["0050", "2330"]) == 0.005, "mixed universe → the stock rate")
check(default_fee("2330", fees={"tw_stock": 0.002}) == 0.002 and DEFAULT_FEES["tw_stock"] == 0.005,
      "fees= overrides one call, table untouched")

# 3 — paper reads strategies/ from the cwd: run it in an empty workspace
ws = tempfile.mkdtemp()
os.chdir(ws)
from lib import order_paper
for sym, spot in (("2330", True), ("0050", True), ("BTCUSDT", False), ("BTCUSDT", True), ("TXF", False)):
    want = default_fee(sym, "spot" if spot else "swap")
    got = order_paper._fee_rate(sym, -1, spot=spot)
    check(got == want, f"paper {sym}{'@spot' if spot else ''} pays the backtest default {want} ({got})")
check(order_paper._fee_rate("AAPL", order_paper.TAKER_FEE) == order_paper.TAKER_FEE,
      "paper: an uncovered market keeps its fixed rate")
os.makedirs("strategies/my_tsmc")
with open("strategies/my_tsmc/strategy.py", "w") as f:
    f.write('SYMBOL = "2330"\nFEE           = 0.0021   # per side: my broker\n')
check(order_paper._fee_rate("2330", -1, spot=True) == 0.0021, "paper: the strategy's own FEE overrides the default")
os.makedirs("strategies/other_tsmc")
with open("strategies/other_tsmc/strategy.py", "w") as f:
    f.write('SYMBOL = "2330"\nFEE = 0.004\n')
check(order_paper._fee_rate("2330", -1, spot=True) == 0.004, "paper: two owners → the higher FEE")

# 4
from lib.runner import _default_fee
check(_default_fee({"SYMBOL": "2330"}) == 0.005 and _default_fee({"SYMBOL": "ETHUSDT", "MARKET": "spot"}) == 0.0015
      and _default_fee({"UNIVERSE": ["0056", "00919"]}) == 0.003 and _default_fee({"SYMBOL": "CL"}) == 0.0005,
      "runner: no FEE → the market default (0.0005 when uncovered)")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
