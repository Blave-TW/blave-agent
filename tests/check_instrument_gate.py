"""instrument_gate: an entry into a stock swap is refused when Binance (the strategy's data)
has the same symbol as a coin — no network.

The libs' real get_contract_rules run with only their HTTP read stubbed, so a lib that stops
reading its venue's class field fails here. Real rows are the venues' public replies as read
2026-10-19 (OKX BB-USDT-SWAP instCategory 3, Bybit ONUSDT symbolType stock, Gate PAXG_USDT
contract_type metals; 2026-10-28 Bitget v3 PAXGUSDT metal/metal while v2 isRwa is YES,
BHPUSDT and MDTUSDT crypto/stock, v3 code 25100 for a symbol it does not list); XYZ / ETFX / USO / SOFTBANK and Bitget BB as a stock are synthetic,
one per branch. The mirror (Binance US stock, venue coin) is refused too. Unreadable on
either side must allow, and a close must always pass — at the gate and through dispatch_order.
Run: cd blave-agent && .venv/bin/python tests/check_instrument_gate.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="instgate-"))

from lib import execute, order_bitget, order_bybit, order_gateio, order_okx, venue_wiring as vw  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


BINANCE = {"BTCUSDT": "COIN", "BBUSDT": "COIN", "ONUSDT": "COIN", "PAXGUSDT": "COIN",
           "XYZUSDT": "COIN", "ETFXUSDT": "COIN", "NVDAUSDT": "EQUITY",
           "USOUSDT": "COMMODITY", "SOFTBANKUSDT": "JP_EQUITY", "MIRRUSDT": "EQUITY",
           "BHPUSDT": "COIN", "MDTUSDT": "EQUITY", "NEWUSDT": "COIN"}
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
       "USO-USDT-SWAP": "3", "SOFTBANK-USDT-SWAP": "3", "MIRR-USDT-SWAP": "1"}
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

# Bitget: v2 rows carry isRwa (YES on all but BTC, PAXG included); the class is v3's
BITGET_V3 = {"PAXGUSDT": ("metal", "metal"), "NVDAUSDT": ("stock", "stock"),
             "BBUSDT": ("stock", "stock"), "BHPUSDT": ("crypto", "stock"),
             "BTCUSDT": ("crypto", "crypto"), "MDTUSDT": ("crypto", "stock")}
bitget_v3_up = [True]
v3_calls = []


def _bitget_public(path, params=None):
    if path == "/api/v2/mix/market/contracts":
        return [{"symbol": params["symbol"], "isRwa": "NO" if params["symbol"] == "BTCUSDT" else "YES",
                 "symbolType": "perpetual", "symbolStatus": "normal", "sizeMultiplier": "0.001",
                 "minTradeNum": "0.001", "minTradeUSDT": "5", "pricePlace": "2", "priceEndStep": "1"}]
    if path == "/api/v3/market/instruments" and params.get("category") == "USDT-FUTURES":
        v3_calls.append(params.get("symbol"))
        if not bitget_v3_up[0]:
            raise requests.exceptions.ConnectionError("stub: Bitget v3 down")
        rows = [{"symbol": s, "baseCoin": s[:-4], "symbolType": st, "instrumentType": it}
                for s, (st, it) in BITGET_V3.items() if params.get("symbol") in (None, s)]
        if not rows:
            raise order_bitget.BitgetError(f"Trading pair {params['symbol']} does not exist", code="25100")
        return rows
    raise AssertionError(f"unstubbed Bitget call {path} {params}")


order_bitget.acct.public = _bitget_public

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
msg = refused("MIRRUSDT")
check(msg == "交易所上的 MIRRUSDT（OKX）是加密幣，不是股票合約，已擋下",
      f"OKX coin vs Binance US stock (the mirror): refused ({msg})")
check(refused("MIRRUSDT", reduce_only=True) is None, "close of the mirror: allowed")
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

venue[0] = "bitget"
check(refused("PAXGUSDT") is None, "Bitget PAXG (isRwa YES, v3 metal) vs Binance coin: allowed")
check(refused("NVDAUSDT") is None, "Bitget NVDA (v3 stock) vs Binance EQUITY: allowed")
msg = refused("BBUSDT")
check(msg == "交易所上的 BBUSDT（Bitget）是股票合約，不是加密幣，已擋下",
      f"Bitget BB (v3 stock) vs Binance coin: refused ({msg})")
check(refused("BHPUSDT") is not None, "Bitget crypto/stock row (fields disagree) counts as a stock: refused")
check(refused("BTCUSDT") is None, "Bitget BTC (crypto/crypto): allowed")
check(refused("MDTUSDT") is None,
      "Bitget MDT (crypto/stock, real) vs Binance EQUITY: allowed (no mirror refusal)")
check(order_bitget.get_contract_rules({}, "NEWUSDT")["equity"] is None,
      "Bitget v3 single read answers 25100 (v2 lists it): equity None")
BITGET_V3["NEWUSDT"] = ("stock", "stock")  # listed after the 6-hour list was read
check(refused("NEWUSDT") is not None and order_bitget.acct._instruments["rows"]
      and "NEWUSDT" not in {r["symbol"] for r in order_bitget.acct._instruments["rows"]},
      "a stock listed after the cached v3 list, Binance coin: refused at once (per-symbol read)")
order_bitget._rules_cache.clear()
bitget_v3_up[0] = False
check(order_bitget.get_contract_rules({}, "BBUSDT")["equity"] is None,
      "Bitget v3 unreadable: equity None (isRwa YES is not read as a stock)")
check(refused("BBUSDT") is None, "Bitget v3 unreadable: allowed and logged (no class given)")
bitget_v3_up[0] = True
del v3_calls[:]
check(refused("BBUSDT") is not None and v3_calls == ["BBUSDT"],
      "after a v3 failure the None was not cached: the next call reads v3 again and refuses")

venue[0] = "binance"
check(refused("NVDAUSDT") is None, "Binance itself: never gated")

venue[0] = "okx"
binance_up[0] = False
from lib import stock_perps  # noqa: E402
stock_perps._binance.update(rows=None, at=0.0, failed_at=0.0)
check(refused("BBUSDT") is None, "Binance exchangeInfo unreadable: allowed (fail open)")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
