"""Per-market default FEE (lib/costs) and paper charging what the backtest charges. No network.

  1. one assertion per market default (Wei 2026-10-22: per side, slippage included), ETN 02 /
     warrants / Type C universe;
  2. fee_of: the strategy's FEE, else its market default, else 0.0005 with a warning; run()
     really backtests with it; scan_grid / run_walk_forward / mcpt refuse a missing fee;
  3. every paper fee point charges the default with literal numbers (a revert to the old
     TAKER / MAKER / SPOT constants fails it), the spot trim and the limit pre-check;
  4. paper's owner FEE: only strategies in the 下單設定, on the same market (spot vs perp),
     Type C by its weights, the TXF family, `FEE: float =`, the LAST assignment, no docstring.
Run: cd blave-agent && .venv/bin/python tests/check_cost_defaults.py
"""
import json, logging, os, socket, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ["BLAVE_MODE"] = "backtest"


def _no_net(*a, **k):
    raise OSError("no network in this test")


socket.socket.connect = _no_net
os.chdir(tempfile.mkdtemp(prefix="costs-"))
for d in ("state", "strategies", "manager"):
    os.makedirs(d)

from lib.costs import default_fee, fee_of  # noqa: E402
from lib import order_paper, paper_data  # noqa: E402

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

def near(a, b):
    return a is not None and b is not None and abs(a - b) < 1e-9

# ── 1. the table ──────────────────────────────────────────────────────────────
check(default_fee("2330") == 0.005 and default_fee("6488.TWO") == 0.005, "TW stock 0.5%")
check(default_fee("0050") == 0.003 and default_fee("00679B") == 0.003, "TW ETF (bond ETF included) 0.3%")
check(default_fee("020000") == 0.003 and default_fee("01001T") == 0.003, "ETN 02… / REIT 01… take the ETF rate")
check(default_fee("BTCUSDT") == 0.001 and default_fee("NVDAUSDT", "swap") == 0.001, "crypto perp 0.1%")
check(default_fee("BTCUSDT", "spot") == 0.0015, "crypto spot 0.15%")
check(all(default_fee(s) == 0.0001 for s in ("TXF", "MXF", "TMF", "TXFR1", "MXFR2")), "TAIFEX index futures 0.01%")
check(all(default_fee(c) == 0.005 for c in ("030001", "089999", "03001P", "08999Y", "711394", "70006C", "73001U")),
      "warrants (TWSE 03–08, TPEx 70–73) take the stock rate, conservative")
check(default_fee("AAPL") is None and default_fee("CL") is None and default_fee("CDF") is None,
      "uncovered markets → None")
check(default_fee("AAPL", us=True) == 0.001 and default_fee("BRK.B", us=True) == 0.001
      and default_fee("TMF", us=True) == 0.001 and default_fee(universe=["SPY", "QQQ"], us=True) == 0.001,
      "US stocks (a fetch_usstock_price strategy) 0.1%, the stock-perp rate; TMF there is the US ETF")
check(default_fee(universe=["0050", "00878"]) == 0.003 and default_fee(universe=["0050", "2330"]) == 0.005,
      "Type C universe: ETFs 0.3%, mixed → the stock rate")

# ── 2. fee_of / run() / the scan libs ─────────────────────────────────────────
class Mod:
    SYMBOL = "2330"
check(fee_of({"FEE": 0.0021, "SYMBOL": "2330"}) == 0.0021, "fee_of: the strategy's FEE wins")
check(fee_of(Mod) == 0.005 and fee_of({"UNIVERSE": ["0056", "00919"]}) == 0.003, "fee_of: no FEE → the market default")
seen = []
class Grab(logging.Handler):
    def emit(self, r):
        seen.append(r.getMessage())
logging.getLogger().addHandler(Grab())
check(fee_of({}) == 0.0005 and fee_of({"SYMBOL": "CL"}) == 0.0005 and len(seen) == 2
      and "no SYMBOL or UNIVERSE" in seen[0] and "not in lib.costs.DEFAULT_FEES" in seen[1],
      "fee_of: market unknown → 0.0005 with a warning saying why")

open("us_strat.py", "w").write('SYMBOL = "SPY"\nfrom lib.data import fetch_usstock_price\n')
class UsMod:
    SYMBOL = "SPY"
    __file__ = os.path.abspath("us_strat.py")
check(fee_of(UsMod) == 0.001, "fee_of: a US strategy without FEE → 0.1%, not 0.0005")

def src_mod(name, src, **consts):
    open(name + ".py", "w").write(src)
    return dict(consts, __file__=os.path.abspath(name + ".py"))
SPY_SIGNAL = ("from lib.data import fetch_usstock_price, fetch_twfutures_ohlcv\n"
              "def fetch_data(h):\n    a = fetch_twfutures_ohlcv(SYMBOL, '2020-01-01', None, h)\n"
              "    b = fetch_usstock_price('SPY', '2020-01-01', None)\n    return a, b\n")
check(fee_of(src_mod("txf_spy", "SYMBOL = 'TXF'\n" + SPY_SIGNAL, SYMBOL="TXF")) == 0.0001,
      "fee_of: a TXF strategy reading SPY as a signal stays TAIFEX 0.01%, not US 0.1%")
check(fee_of(src_mod("mxf_note", "SYMBOL = 'MXF'\n# fetch_usstock_price not used here\n"
                     "x = fetch_twfutures_ohlcv(SYMBOL)\n", SYMBOL="MXF")) == 0.0001,
      "fee_of: fetch_usstock_price only in a comment does not make it a US strategy")
seen.clear()
check(fee_of(src_mod("cdf_spy", "SYMBOL = 'CDF'\n" + SPY_SIGNAL, SYMBOL="CDF")) == 0.0005 and seen
      and "not in lib.costs.DEFAULT_FEES" in seen[-1] and "unread" not in seen[-1],
      "fee_of: a TAIFEX stock future (CDF) reading SPY is not a US stock (the uncovered 0.0005)")
check(fee_of(src_mod("tmf_etf", "SYMBOL = 'TMF'\nfrom lib.data import fetch_usstock_price\n"
                     "def fetch_data(h):\n    return fetch_usstock_price(SYMBOL, '2020-01-01', None)\n",
                     SYMBOL="TMF")) == 0.001,
      "fee_of: TMF priced by fetch_usstock_price(SYMBOL) is the US ETF, 0.1%")
check(fee_of(src_mod("us_loop", "UNIVERSE = ['AAPL', 'MSFT']\nfrom lib.data import fetch_usstock_price\n"
                     "def fetch_data(h):\n    return {t: fetch_usstock_price(t, '2020-01-01', None) for t in UNIVERSE}\n",
                     UNIVERSE=["AAPL", "MSFT"])) == 0.001,
      "fee_of: a Type C looping fetch_usstock_price over its UNIVERSE (its only price fetcher) is US, 0.1%")
seen.clear()
check(fee_of({"SYMBOL": "SPY"}) == 0.0005 and seen and "no __file__" in seen[-1],
      "fee_of: no __file__ → the warning names the unread source, not only the table")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import lib.runner as R  # noqa: E402
import lib.data, lib.strategy, lib.validation  # noqa: E402
from pathlib import Path  # noqa: E402
# the backtest writes here, never into the repo
R._REPO_ROOT = lib.strategy._REPO_ROOT = Path(os.getcwd())
lib.validation._REPO_ROOT = os.getcwd()
lib.data._CACHE_DIR = Path(os.getcwd()) / "cache"
idx = pd.date_range("2025-01-01", periods=400, freq="1h")
px = 100 * np.exp(np.cumsum(np.random.default_rng(1).normal(0, 0.01, 400)))
DF = pd.DataFrame({"Open": px, "High": px, "Low": px, "Close": px, "Volume": 1.0}, index=idx)
R.run({"STRATEGY_NAME": "nofee", "SYMBOL": "ETHUSDT", "MARKET": "spot", "INTERVAL": "1h",
       "START": "2025-01-01", "WARMUP": 20, "MCPT": False},
      lambda h: DF.copy(), lambda df: (df["Close"] > df["Close"].rolling(20).mean()).astype(float))
st = json.load(open("strategies/nofee/stats.json"))
check(near(st.get("fee [%]"), 0.15), f"run() without FEE backtests at the market default ({st.get('fee [%]')}%)")
R.run({"STRATEGY_NAME": "usnofee", "SYMBOL": "SPY", "INTERVAL": "1h", "START": "2025-01-01", "WARMUP": 20,
       "MCPT": False, "__file__": os.path.abspath("us_strat.py")},
      lambda h: DF.copy(), lambda df: (df["Close"] > df["Close"].rolling(20).mean()).astype(float))
st = json.load(open("strategies/usnofee/stats.json"))
check(near(st.get("fee [%]"), 0.1), f"run() of a US strategy without FEE backtests at 0.1% ({st.get('fee [%]')}%)")

from lib.param_scan import scan_grid  # noqa: E402
from lib.walk_forward import run_walk_forward  # noqa: E402
from lib.validation import mcpt  # noqa: E402
for name, call in (("scan_grid", lambda: scan_grid(DF, lambda d, a, b: d["Close"] * 0, [1], [0])),
                   ("run_walk_forward", lambda: run_walk_forward(DF, None, [1], [0], ".", "A", "B")),
                   ("mcpt", lambda: mcpt(DF["Close"].values, np.zeros(400), n=5))):
    try:
        call()
        check(False, f"{name} without fee must refuse")
    except ValueError as e:
        check("fee_of" in str(e), f"{name} without fee refuses and names fee_of ({e})")

# ── 3. every paper fee point, no owner → the market default ──────────────────
MARK = {"BTCUSDT": 50000.0, "TXF": 20000.0}
order_paper._price = lambda env, symbol, cache=None: MARK[str(symbol).upper()]
order_paper.usd_rate = lambda ccy, env, max_age=None: 1.0 if str(ccy).upper() in ("USD", "USDT") else 32.0
ENV = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "1",
       "PAPER_INITIAL_EQUITY": "100000"}
json.dump({"amounts": {}, "exchanges": {}}, open("manager/portfolio_config.json", "w"))

def led():
    return json.load(open(order_paper.LEDGER_PATH))

def last_fee():
    return led()["fills"][-1]["fee"]

def fresh():
    order_paper.reset_account(ENV)

fresh()
order_paper.place_market_order(ENV, "BTCUSDT", "long", 0.1)
check(near(last_fee(), 5.0), f"1 market order: 5,000 × 0.1% = 5 ({last_fee()})")
order_paper.place_limit_order(ENV, "BTCUSDT", "long", 0.1, 51000)
check(near(last_fee(), 5.0), f"2 crossing limit: 5 ({last_fee()})")
order_paper.place_limit_order(ENV, "BTCUSDT", "long", 0.1, 49000)
MARK["BTCUSDT"] = 48000.0
order_paper.snapshot(ENV)
check(near(last_fee(), 4.9), f"3 resting limit fill at 49,000: 4,900 × 0.1% = 4.9 ({last_fee()})")
order_paper.place_protective_orders(ENV, "BTCUSDT", "long", sl_price=47000)
MARK["BTCUSDT"] = 46000.0
order_paper.snapshot(ENV)
check(near(last_fee(), 0.3 * 46000 * 0.001), f"4 SL trigger: 0.3 × 46,000 × 0.1% = 13.8 ({last_fee()})")
MARK["BTCUSDT"] = 50000.0
order_paper.place_contract_market_order(ENV, "TXF", "long", 1, 200, margin=100000)
check(near(last_fee(), 20000 * 200 * 0.0001 / 32), f"5 TXF lot: 400 TWD ÷ 32 = 12.5 ({last_fee()})")
order_paper.place_contract_market_order(ENV, "TXF", "long", 1, 200, reduce_only=True)
fresh()
order_paper.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=1000)
check(near(last_fee(), 1.5), f"6 spot market buy: 1,000 × 0.15% = 1.5 ({last_fee()})")
order_paper.place_spot_limit_order(ENV, "BTCUSDT", "buy", 0.02, 51000)
check(near(last_fee(), 1.5), f"7 spot crossing limit: 1,000 × 0.15% = 1.5 ({last_fee()})")
order_paper.place_spot_limit_order(ENV, "BTCUSDT", "buy", 0.02, 49000)
MARK["BTCUSDT"] = 48000.0
order_paper.snapshot(ENV)
check(near(last_fee(), 980 * 0.0015), f"8 spot resting fill at 49,000: 980 × 0.15% = 1.47 ({last_fee()})")
MARK["BTCUSDT"] = 50000.0

fresh()
cash = led()["cash"]
q = cash / 50000 / 1.0012  # covers 1 + 0.1% (the old SPOT_FEE), not 1 + 0.15%
try:
    order_paper.place_spot_limit_order(ENV, "BTCUSDT", "buy", q, 50000)
    check(False, "9 spot limit pre-check at 0.15% refuses a buy only the old 0.1% covers")
except order_paper.PaperError as e:
    check("to rest" in str(e), f"9 spot limit pre-check at 0.15% refuses a buy only the old 0.1% covers ({e})")
order_paper.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=cash)
L = led()
check(0 <= L["cash"] < 1e-3 and near(L["spot"]["BTC"], cash / 50000 / 1.0015 * (1 - 1e-9)),
      f"trim: a buy of the whole cash fills cash ÷ (1 + 0.15%), cash left ~0 ({L['cash']:.6f})")
n = len(L["fills"])
gap = cash - L["spot"]["BTC"] * 50000
check(order_paper.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=gap) is False
      and len(led()["fills"]) == n, f"the fee-sized gap left ({gap:.2f}) is nothing to buy: False, no error")
try:
    order_paper.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=5000)
    check(False, "a buy far past the cash is still refused")
except order_paper.PaperError:
    check(True, "a buy far past the cash is still refused")
fresh()
order_paper.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=99800)  # big holding, ~50 cash left
cash = led()["cash"]
try:  # an add inside 2 × fee × holding (~296) — only cash ~0 makes it the trim's gap
    order_paper.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=cash + 200)
    check(False, "a small add with only part of it in cash is refused, not skipped")
except order_paper.PaperError:
    check(True, f"a small add with only part of it in cash ({cash:.0f} of {cash + 200:.0f}) is refused, not skipped")

# ── 4. owner FEE ──────────────────────────────────────────────────────────────
def strat(name, src, state=None):
    os.makedirs(f"strategies/{name}", exist_ok=True)
    open(f"strategies/{name}/strategy.py", "w").write(src)
    if state is not None:
        json.dump(state, open(f"strategies/{name}/state.json", "w"))

def picked(*names):
    json.dump({"amounts": {n: 1000 for n in names}, "exchanges": {n: "paper" for n in names}},
              open("manager/portfolio_config.json", "w"))

strat("live_tw", 'SYMBOL = "2330"\nMARKET = "swap"\nFEE = 0.002  # per side\n')
strat("draft_tw", 'SYMBOL = "2330"\nFEE = 0.01\n')
strat("perp", 'SYMBOL = "BTCUSDT"\nMARKET = "swap"\nFEE = 0.0007\n')
strat("perp_v2", 'SYMBOL = "BTCUSDT"\nFEE = 0.0009\n')
strat("spot", 'SYMBOL = "BTCUSDT"\nMARKET = "spot"\nFEE: float = 3e-3\n')
strat("basket", 'MARKET = "spot"\nFEE = 0.004\nUNIVERSE = [c for c in ("2454",)]\n',
      {"type": "portfolio", "weights": {"2454": 0.5, "2317": 0.5}})
strat("mixed_nofee", 'MARKET = "spot"\nUNIVERSE = ["0050", "2330"]\n', {"type": "portfolio", "weights": {"0050": 1.0}})
strat("mxf", 'SYMBOL = "MXF"\nFEE = 0.0002\n')
strat("mxf_next", 'SYMBOL = "MXFR2"\nFEE = 0.0003\n')
strat("warrant", 'SYMBOL = "711394"\nFEE = 0.02\n')
strat("weird", 'SYMBOL = "DOGEUSDT"\nFEE = 0.004\nFEE = {[1]: 2}\n')
strat("last", '"""\nFEE = 0.02\n"""\nSYMBOL = "ETHUSDT"\nFEE = 0.001\nFEE = 0.004\n')
strat("computed", 'SYMBOL = "SOLUSDT"\nFEE = 0.003\nFEE = 0.001 * 2\n')
strat("us_spy", 'SYMBOL = "SPY"\nfrom lib.data import fetch_usstock_price\n')
strat("us_qqq", 'SYMBOL = "QQQ"\nfrom lib.data import fetch_usstock_price\n')
strat("txf_spy", 'SYMBOL = "TXF"\n' + SPY_SIGNAL)
strat("cdf_spy", 'SYMBOL = "CDF"\n' + SPY_SIGNAL)
picked("live_tw", "us_spy", "perp", "perp_v2", "spot", "basket", "mixed_nofee", "mxf", "mxf_next", "warrant", "weird", "last", "computed")

check(paper_data.strategy_fee("2330", spot=True) == 0.002, "a draft outside the 下單設定 never counts (0.002, not 0.01)")
check(paper_data.strategy_fee("BTCUSDT", spot=False) == 0.0009 and paper_data.strategy_fee("BTCUSDT", spot=True) == 0.003,
      "MARKET: perp fills take the perp owners' FEE (two → the higher), spot fills the spot one's (FEE: float = 3e-3)")
check(paper_data.strategy_fee("2317", spot=True) == 0.004, "Type C owner found by its state.json weights")
check(paper_data.strategy_fee("0050", spot=True) == 0.005, "Type C without FEE: the highest over its universe, as the backtest")
check(paper_data.strategy_fee("TXF") == 0.0003, "TXF family: MXF and MXFR2 owners cover a TXF fill (the higher, 0.0003)")
check(paper_data.strategy_fee("711394", spot=True) == 0.02, "a TPEx warrant strategy without MARKET still owns its share fill")
check(paper_data.strategy_fee("DOGEUSDT") == 0.001, "an unhashable last FEE literal (TypeError) is unknown: the market default, the fill goes on")
check(paper_data.strategy_fee("SPY") == 0.001, "a picked US strategy without FEE: paper charges 0.1%")
check(order_paper._fee_rate("QQQ", order_paper.TAKER_FEE) == 0.001,
      "a US ticker only an unpicked fetch_usstock_price strategy reads: 0.1%, not TAKER_FEE")
check(not paper_data._us_owned("TXF") and not paper_data._us_owned("CDF"),
      "paper: TXF / CDF strategies reading SPY as a signal do not make TXF / CDF US tickers")
check(paper_data._us_owned("SPY") and paper_data._us_owned("QQQ"),
      "paper: _us_owned (cached) still finds the US strategies")
check(order_paper._fee_rate("CDF", order_paper.TAKER_FEE) == order_paper.TAKER_FEE,
      "paper: a CDF fill is not charged the US 0.1% because its strategy reads SPY")
check(paper_data.strategy_fee("ETHUSDT") == 0.004, "the LAST FEE assignment wins; a docstring FEE line is not code")
check(paper_data.strategy_fee("SOLUSDT") == 0.001, "a computed last FEE is unknown: the market default, not the earlier literal")
path = "strategies/live_tw/strategy.py"
st0 = os.stat(path)
open(path, "w").write('SYMBOL = "2330"\nFEE = 0.0035 # per side\n')
os.utime(path, ns=(st0.st_atime_ns, st0.st_mtime_ns))  # same mtime (cp -p / rsync -t), new size
check(paper_data.strategy_fee("2330", spot=True) == 0.0035, "the cache sees a rewrite that kept the mtime (the size changed)")
picked("perp")
check(paper_data.strategy_fee("2330", spot=True) is None, "owner left the 下單設定 → no owner")
order_paper.reset_account(ENV)
order_paper.place_market_order(ENV, "BTCUSDT", "long", 0.1)
check(near(last_fee(), 5000 * 0.0007), f"paper fill charges the picked owner's FEE ({last_fee()})")

print("all ok" if not fails else "FAILED")
sys.exit(1 if fails else 0)
