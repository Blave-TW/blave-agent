"""instrument_gate: an entry into a stock swap is refused when Binance (the strategy's data)
has the same symbol as a coin — no network.

The libs' real get_contract_rules run with only their HTTP read stubbed, so a lib that stops
reading its venue's class field fails here. Real rows are the venues' public replies as read
2026-10-19 (OKX BB-USDT-SWAP instCategory 3, Bybit ONUSDT symbolType stock, Gate PAXG_USDT
contract_type metals); XYZ / ETFX / USO / SOFTBANK are synthetic, one per branch. Unreadable on
either side must allow, and a close must always pass — at the gate and through dispatch_order.
Run: cd blave-agent && .venv/bin/python tests/check_instrument_gate.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="instgate-"))

from lib import execute, order_bybit, order_gateio, order_okx, venue_wiring as vw  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


BINANCE = {"BTCUSDT": "COIN", "BBUSDT": "COIN", "ONUSDT": "COIN", "PAXGUSDT": "COIN",
           "XYZUSDT": "COIN", "ETFXUSDT": "COIN", "NVDAUSDT": "EQUITY",
           "USOUSDT": "COMMODITY", "SOFTBANKUSDT": "JP_EQUITY"}
binance_up = [True]


class _Resp:
    def raise_for_status(self):
        pass

    def json(self):
        return {"symbols": [{"symbol": s, "underlyingType": t} for s, t in BINANCE.items()]}


def _get(url, timeout=None):
    if not binance_up[0]:
        raise ConnectionError("stub: Binance down")
    return _Resp()


import requests  # noqa: E402
requests.get = _get

OKX = {"BTC-USDT-SWAP": "1", "BB-USDT-SWAP": "3", "NVDA-USDT-SWAP": "3", "QNT-USDT-SWAP": None,
       "USO-USDT-SWAP": "3", "SOFTBANK-USDT-SWAP": "3"}
order_okx._send = lambda m, p, env, body=None, params=None, retries=3: [dict(
    {"ctVal": "1", "lotSz": "0.01", "minSz": "0.01", "tickSz": "0.01", "state": "live",
     "last": "8.0"},
    **({} if OKX[params["instId"]] is None else {"instCategory": OKX[params["instId"]]}))]
order_bybit._public = lambda env, path, params: {"list": [{
    "lotSizeFilter": {"qtyStep": "0.1", "minOrderQty": "0.1"}, "priceFilter": {"tickSize": "0.0001"},
    "symbolType": {"ONUSDT": "stock", "ETFXUSDT": "ETF", "BTCUSDT": ""}[params["symbol"]]}]}
order_gateio._send = lambda m, p, env, body=None, query="", retries=3: {
    "quanto_multiplier": "0.01", "order_size_min": 1,
    "contract_type": {"/futures/usdt/contracts/PAXG_USDT": "metals",
                      "/futures/usdt/contracts/XYZ_USDT": "stocks"}[p]}

venue = ["okx"]
vw.read_env = lambda path=".env": {}
vw.detect_venue = lambda env: venue[0]


def refused(symbol, reduce_only=False, gate=vw.instrument_gate):
    try:
        gate(symbol, reduce_only)
    except RuntimeError as e:
        return str(e)
    return None


msg = refused("BBUSDT")
check(msg == "交易所上的 BBUSDT（OKX）是股票合約，不是加密幣，已擋下",
      f"OKX BB-USDT-SWAP (stock) vs Binance BBUSDT (coin): refused, no reject token ({msg})")
check(refused("BTCUSDT") is None, "OKX BTC (crypto): allowed")
check(refused("NVDAUSDT") is None, "OKX NVDA stock, Binance NVDAUSDT stock too: allowed")
check(refused("USOUSDT") is None, "OKX stock vs Binance COMMODITY: allowed (only COIN counts)")
check(refused("SOFTBANKUSDT") is None, "OKX stock vs a Binance class added later: allowed")
check(refused("QNTUSDT") is None, "OKX row without instCategory: allowed")
check(refused("BBUSDT", reduce_only=True) is None, "close of a stock swap: allowed")
check(refused("BBUSDT@spot") is None, "spot key: not gated")

# dispatch_order: the entry is refused before any order goes out, the close goes through
calls = []
real_place = vw.auto_place_order
vw.auto_place_order = lambda *a, **k: calls.append(a) or False
try:
    execute.dispatch_order("BBUSDT", 50.0)
    check(False, "dispatch_order: entry into BB on OKX refused")
except Exception as e:
    check(isinstance(e, RuntimeError) and "股票" in str(e) and not calls,
          f"dispatch_order: entry into BB on OKX refused before auto_place_order ({type(e).__name__})")
try:
    got = execute.dispatch_order("BBUSDT", -50.0, reduce_only=True)
    check(got is False and len(calls) == 1, "dispatch_order: close of BB on OKX goes through")
except Exception as e:
    check(False, f"dispatch_order: close of BB on OKX goes through (raised {type(e).__name__}: {e})")
vw.auto_place_order = real_place

# auto_place_order's own entry gate (TWAP slices, chase fallback, custom executors)
sent = []
real_okx_place = order_okx.place_market_order
order_okx.place_market_order = lambda *a, **k: sent.append(a) or False
try:
    vw.auto_place_order("BBUSDT", 50.0)
    check(False, "auto_place_order: entry into BB on OKX refused")
except Exception as e:
    check(isinstance(e, RuntimeError) and "股票" in str(e) and not sent,
          f"auto_place_order: entry into BB on OKX refused before the order ({type(e).__name__})")
order_okx.place_market_order = real_okx_place

venue[0] = "bybit"
check(refused("ONUSDT") is not None, "Bybit ONUSDT (symbolType stock) vs Binance coin: refused")
check(refused("ETFXUSDT") is not None, "Bybit symbolType ETF vs Binance coin: refused")
check(refused("BTCUSDT") is None, "Bybit BTC: allowed")

venue[0] = "gateio"
check(refused("XYZUSDT") is not None, "Gate contract_type stocks vs Binance coin: refused")
check(refused("PAXGUSDT") is None, "Gate PAXG (metals, a coin on Binance): allowed")

venue[0] = "binance"
check(refused("NVDAUSDT") is None, "Binance itself: never gated")

venue[0] = "okx"
binance_up[0] = False
vw._binance_coin.update(rows=None, at=0.0, failed_at=0.0)
check(refused("BBUSDT") is None, "Binance exchangeInfo unreadable: allowed (fail open)")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
