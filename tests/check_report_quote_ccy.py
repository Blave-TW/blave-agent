"""The portfolio report's per-strategy amount currency (`quote_ccy`, designer spec
0124-review/units-research-and-spec.md §3.1 layer 2): known for sure or null, never guessed.

  crypto pair suffix USDT / USDC / FDUSD / BUSD → that; bare USD (BTCUSD) → null (no
  coin-margined path exists to say it is BTC); Type C → its weights' common suffix, mixed →
  null; Taiwan stock / index futures / stock futures → TWD; US stock → USD; user data,
  global futures, mixed markets → null. Picked strategies with no state.json are in the map.

Run: cd blave-agent && .venv/bin/python tests/check_report_quote_ccy.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="quote-ccy-")
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import portfolio_reporter as pr  # noqa: E402

CRYPTO = "from lib.data import fetch_kline\nSYMBOL = {s!r}\nINTERVAL = '1h'\n"
STRATS = {
    # name: (source, state.json or None, expected)
    "a_usdt":  (CRYPTO.format(s="BTCUSDT"), {"symbol": "BTCUSDT", "position": 1}, "USDT"),
    "a_usdc":  (CRYPTO.format(s="ETH-USDC"), None, "USDC"),
    "a_fdusd": (CRYPTO.format(s="BTCFDUSD"), {"symbol": "BTCFDUSD", "position": 0}, "FDUSD"),
    "a_busd":  (CRYPTO.format(s="BNBBUSD"), None, "BUSD"),
    "a_usd":   (CRYPTO.format(s="BTCUSD"), {"symbol": "BTCUSD", "position": 1}, None),
    "c_usdt":  ("from lib.data import fetch_kline_batch\n# Type: C\n",
                {"type": "portfolio", "weights": {"BTCUSDT": 0.5, "ETHUSDT": 0.2}}, "USDT"),
    "c_mixed": ("from lib.data import fetch_kline_batch\n# Type: C\n",
                {"type": "portfolio", "weights": {"BTCUSDT": 0.5, "ETHUSDC": 0.2}}, None),
    "c_nostate": ("from lib.data import fetch_kline_batch\n# Type: C\n", None, None),
    "tw_stock": ("from lib.data import fetch_twstock_price\nSYMBOL = '2330'\n", None, "TWD"),
    "tw_c":    ("from lib.data import fetch_twstock_price_batch\n# Type: C\n",
                {"type": "portfolio", "weights": {"2330": 0.5, "2317": 0.5}}, "TWD"),
    "txf":     ("from lib.data import fetch_twfutures_ohlcv\nSYMBOL = 'TXF'\n", None, "TWD"),
    "stockfut": ("from lib.data import fetch_twfutures_ohlcv\nSYMBOL = 'CDF'\n", None, "TWD"),
    "us":      ("from lib.data import fetch_usstock_price\nSYMBOL = 'AAPL'\n", None, "USD"),
    "global":  ("from lib.data import fetch_db_kline\nSYMBOL = 'CL'\n", None, None),
    "mixed":   ("from lib.data import fetch_kline, fetch_twstock_price\nSYMBOL = 'BTCUSDT'\n",
                None, None),
    "own_data": ("import pandas as pd\nSYMBOL = 'BTCUSDT'\n", None, None),
    "broken":  ("def (:\n", None, None),
}

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


try:
    for name, (src, state, _) in STRATS.items():
        d = os.path.join(WS, "strategies", name)
        os.makedirs(d)
        open(os.path.join(d, "strategy.py"), "w").write(src)
        if state is not None:
            json.dump(state, open(os.path.join(d, "state.json"), "w"))
    picked = {n: 100 for n, (_, st, _) in STRATS.items() if st is None}
    got = pr.quote_ccys({"amounts": picked})
    for name, (_, _, want) in STRATS.items():
        check(got.get(name, "absent") == want, f"{name}: {want} → {got.get(name, 'absent')}")
    check(set(got) == set(STRATS), "every picked strategy and every one with a state.json is in the map")
    check(pr.quote_ccys({}) == {n: w for n, (_, st, w) in STRATS.items() if st is not None},
          "nothing picked: only strategies with a state.json")
    os.makedirs(os.path.join(WS, "manager"))
    json.dump({"amounts": picked}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
    rep = pr.build_report()
    check(rep.get("quote_ccy") == got and json.dumps(rep["quote_ccy"]),
          "build_report carries the same map as `quote_ccy`, JSON-serializable")
finally:
    shutil.rmtree(WS, ignore_errors=True)

print("\ncheck_report_quote_ccy: " + ("PASS" if not fails else f"FAILED ({fails})"))
sys.exit(1 if fails else 0)
