"""The shares the portfolio page lists for a paper TW stock are the shares the paper
account buys (Wei 10-18, audit 0127-order-path-cross P1-1). End to end, offline:
a live tick of a Type A (MARKET swap) and a Type C writes state.json with the raw
close (lib/runner, the lookup child on a fake batch feed); runtime
portfolio_reporter.tw_lots turns the amounts into shares; then real reconcile
rounds go reconcile → manager/reconciler.place_order → lib.execute → venue_wiring →
order_paper, which price through lib/paper_data. The strategies' own fetch_data and
lib.data.fetch_twstock_price_adj answer a different (adjusted) price, so a fill at
the adjusted close fails the comparison.

Run: cd blave-agent && .venv/bin/python tests/check_paper_tw_page_shares.py
"""
import contextlib
import io
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = Path(tempfile.mkdtemp(prefix="tw-page-shares-", dir=os.environ.get("SCRATCHPAD") or None))
os.environ["BLAVE_AGENT_WORKSPACE"] = str(WS)
os.environ["BLAVE_AGENT_BASE"] = str(WS)
os.environ.setdefault("MPLBACKEND", "Agg")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import dotenv  # noqa: E402
dotenv.dotenv_values = lambda *a, **k: {}

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

os.chdir(WS)
os.symlink(os.path.join(ROOT, "lib"), WS / "lib")   # venue_wiring finds lib/order_paper.py from the cwd
for d in ("state", "manager", "strategies/tw_a", "strategies/tw_c"):
    (WS / d).mkdir(parents=True, exist_ok=True)
(WS / ".env").write_text("PAPER_API_KEY=paper\nPAPER_SECRET_KEY=paper\nPAPER_BOUND_TS=1\n"
                         "PAPER_INITIAL_EQUITY=200000\n")
json.dump({"rates": {"TWD": 32.0}, "ts": int(time.time())}, open("state/paper_fx.json", "w"))

RAW = {"2330": 2420.0, "2454": 1255.0, "2317": 201.5}
ADJ = 1.1388   # 2330: 2420 raw vs 2755.89 adjusted from 2020 (lib/runner docstring)
DAY = "2026-10-16"
(WS / "raw.json").write_text(json.dumps(RAW))
(WS / "twfake.py").write_text('''
import json
import pandas as pd


def batch(codes, start, end, hdrs):
    raw = json.load(open("raw.json"))
    return {c: pd.DataFrame({"Close": [raw[c] - 5, raw[c], raw[c] + 77]},
                            index=pd.to_datetime(["2026-10-15", "2026-10-16", "2026-10-17"]))
            for c in codes if c in raw}
''')
ADJ_SRC = f'''
def fetch_data(hdrs):
    import pandas as pd
    return pd.DataFrame({{"Open": 2420.0 * {ADJ}, "Close": 2420.0 * {ADJ}}},
                        index=pd.to_datetime(["{DAY}"]))
'''
(WS / "strategies/tw_a/strategy.py").write_text('SYMBOL = "2330"\nMARKET = "swap"\nINTERVAL = "1d"\n' + ADJ_SRC)
(WS / "strategies/tw_c/strategy.py").write_text('MARKET = "spot"\nINTERVAL = "1d"\nSTART = "2020-01-01"\n' + ADJ_SRC)

import lib.data as data  # noqa: E402
import lib.runner as runner  # noqa: E402

runner.dotenv_values = lambda *a, **k: {}
runner._REPO_ROOT = WS
runner.TW_CLOSE_FETCH = "twfake:batch"

fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


IDX = pd.bdate_range("2026-06-01", DAY)
CLOSE = pd.DataFrame({c: np.linspace(RAW[c] * 0.8, RAW[c] * ADJ, len(IDX)) for c in ("2330", "2454", "2317")},
                     index=IDX)


def live(fn):
    os.environ["BLAVE_MODE"] = "live"
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            fn()
    finally:
        os.environ["BLAVE_MODE"] = "backtest"


live(lambda: runner.run(
    {"STRATEGY_NAME": "tw_a", "SYMBOL": "2330", "INTERVAL": "1d", "START": "2026-06-01", "FEE": 0.003,
     "MARKET": "swap", "__file__": str(WS / "strategies/tw_a/strategy.py")},
    lambda h: pd.DataFrame({k: CLOSE["2330"] for k in ("Open", "High", "Low", "Close")}).assign(Volume=1.0),
    lambda df: pd.Series(1.0, index=df.index)))
basket = CLOSE[["2454", "2317"]]
live(lambda: runner.run(
    {"STRATEGY_NAME": "tw_c", "INTERVAL": "1d", "START": "2026-06-01", "FEE": 0.003, "MARKET": "spot",
     "__file__": str(WS / "strategies/tw_c/strategy.py")},
    lambda h: (basket.copy(), basket.copy()),
    lambda d: (np.full((len(d[0]), 2), 0.5), pd.concat({"close": d[0], "open": d[1]}, axis=1))))
st_a = json.loads((WS / "strategies/tw_a/state.json").read_text())
st_c = json.loads((WS / "strategies/tw_c/state.json").read_text())
check(st_a.get("position") == 1.0 and st_a.get("raw_closes") == {"2330": 2420.0},
      f"Type A tick: long, raw close in state.json ({st_a.get('position')}, {st_a.get('raw_closes')})")
check(st_c.get("weights") == {"2454": 0.5, "2317": 0.5} and st_c.get("raw_closes") == {"2454": 1255.0, "2317": 201.5},
      f"Type C tick: weights and raw closes in state.json ({st_c.get('weights')}, {st_c.get('raw_closes')})")

AMOUNTS = {"tw_a": 1_000_000, "tw_c": 1_000_000}
cfg = {"amounts": AMOUNTS, "exchanges": {"tw_a": "paper", "tw_c": "paper"}, "asset_specs": {}}
json.dump(cfg, open("manager/portfolio_config.json", "w"))

import portfolio_reporter as pr  # noqa: E402

page = pr.tw_lots(cfg, pr.strategy_states(), {"paper": {"credentials": True, "pair": True, "order": True,
                                                         "account": True}})
want = {"2330@spot": 413, "2454@spot": 398, "2317@spot": 2481}
check({k: (v["shares"], v["unit"]) for k, v in page.items()} == {k: (n, "shares") for k, n in want.items()},
      f"page: 1,000,000 at 2420 = 413; 500,000 at 1255 = 398 and at 201.5 = 2481 shares ({page})")


def _offline(*a, **k):
    raise OSError("offline test")


socket.socket.connect = _offline
socket.create_connection = _offline
asked = []


def raw_daily(code, start, end, hdrs):
    asked.append(code)
    # the morning after the round: the round's own close is the latest bar
    return pd.DataFrame({"Open": RAW[code], "High": RAW[code], "Low": RAW[code], "Close": RAW[code],
                         "Volume": 1.0}, index=pd.to_datetime([DAY]))


def adj_daily(code, start, end, hdrs):
    return pd.DataFrame({"Open": RAW[code] * ADJ, "Close": RAW[code] * ADJ}, index=pd.to_datetime([DAY]))


data.fetch_twstock_price = raw_daily
data.fetch_twstock_price_adj = adj_daily
data.fetch_twstock_price_adj_batch = lambda ids, *a: {c: adj_daily(c, *a) for c in ids}

from lib import guard, order_paper, paper_data, portfolio, venue_wiring  # noqa: E402

paper_data.tw_session_open = lambda env=None, now=None: True
order_paper.tw_session_open = paper_data.tw_session_open
from manager import reconciler as rec  # noqa: E402

ENV = venue_wiring.read_env()


def held():
    return {k: v for k, v in order_paper.get_spot_balances(ENV).items() if k not in ("USDT", "USDC")}


def round_():
    with contextlib.redirect_stdout(io.StringIO()):
        portfolio.reconcile(getattr(rec, "_get_positions_guarded", rec.get_positions), rec.place_order,
                            threshold=rec.THRESHOLD)


for _ in range(3):
    round_()
book = held()
for key, n in want.items():
    code = key[:-len("@spot")]
    check(book.get(code) == n, f"{key}: paper bought {book.get(code)} shares, the page says {n}")
check(not guard.halted() and not os.path.exists(portfolio._PAPER_TW_CLOSE_PATH), "no halt, no deferral in play")
check(set(asked) >= {"2330", "2454", "2317"}, f"paper priced every TW code off the unadjusted close ({sorted(set(asked))})")
fills = [f for f in order_paper.snapshot(ENV)["fills"] if f.get("symbol") in ("2330", "2454", "2317")]
check(fills and all(abs(float(f["price"]) - RAW[f["symbol"]]) < 1e-9 for f in fills),
      f"every fill at the raw close ({[(f['symbol'], f['price']) for f in fills]})")
before = len(fills)
round_()
check(len([f for f in order_paper.snapshot(ENV)["fills"] if f.get("symbol") in RAW]) == before,
      "the next round on the same target sends nothing")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
