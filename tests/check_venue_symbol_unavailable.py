"""A symbol the bound exchange does not list is tagged [order_reject:symbol_unavailable] on the
FIRST request that meets it — the price read (get_mark_price) runs before any rules read, so
the tag has to come from the venue's own "no such instrument" reply there, or the user gets the
raw venue text and the backoff waits out REJECT_UNTAGGED_FREE more rounds (lib/portfolio).

Replies below are the ones measured 2026-11-21 on each venue's public endpoint for an unlisted
name (OKX XAUT-USDT-SWAP, Binance TSLA, Bybit AMZN, Gate.io / BingX / Bitget a made-up name).
A neighbouring reply that does NOT mean "no such symbol" stays untagged.
No network: requests is replaced by a fake that answers the measured body.

Run: cd blave-agent && .venv/bin/python tests/check_venue_symbol_unavailable.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="venue-symbol-unavailable-", dir=os.environ.get("SCRATCHPAD") or None))

import requests  # noqa: E402


class _Reply:
    def __init__(self, status, body):
        self.status_code, self._body = status, body
        self.text = json.dumps(body)
        self.content = self.text.encode()
        self.ok = status < 400
        self.headers = {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code), response=self)


REPLY = {}
requests.get = requests.post = requests.request = lambda *a, **k: REPLY["r"]

from lib import reject_token as R  # noqa: E402
import lib.order_binance as bn  # noqa: E402
import lib.order_bingx as bx  # noqa: E402
import lib.order_bitget as bg  # noqa: E402
import lib.order_bybit as by  # noqa: E402
import lib.order_gateio as gt  # noqa: E402
import lib.order_okx as okx  # noqa: E402
import lib.order_stockcoin as sc  # noqa: E402
import lib.stock_perps as sp  # noqa: E402

sp.binance_rows = lambda: {}   # no stock-perp renames in play
ENV = {"OKX_API_KEY": "a", "OKX_SECRET_KEY": "b", "OKX_PASSPHRASE": "c",
       "GATEIO_API_KEY": "a", "GATEIO_SECRET_KEY": "b"}
fails = 0


def check(cond, msg):
    global fails
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    fails += (not cond)


def kind(e):
    m = R._TOKEN_RE.match(str(e))
    return m.group(1) if m else None


def mark_price_error(mod, sym, status, body):
    REPLY["r"] = _Reply(status, body)
    try:
        mod.get_mark_price(ENV, sym)
    except Exception as e:  # noqa: BLE001 — the message is what is under test
        return e
    return None


UNLISTED = [
    ("OKX 51001 on /market/ticker", okx, "XAUTUSDT", 200,
     {"code": "51001", "data": [], "msg": "Instrument ID, Instrument ID code, or Spread ID doesn't exist."}),
    ("Binance -1121 on premiumIndex", bn, "TSLA", 400, {"code": -1121, "msg": "Invalid symbol."}),
    ("Bybit 10001 symbol invalid on tickers", by, "AMZN", 200,
     {"retCode": 10001, "retMsg": "params error: symbol invalid", "result": {}}),
    ("Gate.io CONTRACT_NOT_FOUND on tickers", gt, "NOPEZZUSDT", 400, {"label": "CONTRACT_NOT_FOUND"}),
    ("BingX 109425 on premiumIndex", bx, "NOPEZZUSDT", 200,
     {"code": 109425, "msg": "NOPEZZ-USDT not exist, please verify it in api: /openApi/swap/v2/quote/contracts", "data": {}}),
    ("Bitget 40034 on ticker", bg, "NOPEZZUSDT", 400,
     {"code": "40034", "msg": "Parameter NOPEZZUSDT does not exist", "data": None}),
]
for name, mod, sym, status, body in UNLISTED:
    e = mark_price_error(mod, sym, status, body)
    check(e is not None and kind(e) == R.SYMBOL_UNAVAILABLE, f"{name} → symbol_unavailable ({str(e)[:90]})")

OTHER = [
    ("Bybit 10001 for another parameter", by, "BTCUSDT", 200,
     {"retCode": 10001, "retMsg": "params error: category invalid", "result": {}}),
    ("OKX 50011 rate limit", okx, "BTCUSDT", 200, {"code": "50011", "data": [], "msg": "Too Many Requests"}),
    ("Binance -1003 rate limit", bn, "BTCUSDT", 400, {"code": -1003, "msg": "Too many requests."}),
    ("Bitget 40037 (not an unknown symbol)", bg, "BTCUSDT", 400,
     {"code": "40037", "msg": "Apikey does not exist", "data": None}),
]
for name, mod, sym, status, body in OTHER:
    e = mark_price_error(mod, sym, status, body)
    check(e is not None and kind(e) != R.SYMBOL_UNAVAILABLE, f"{name} stays out of symbol_unavailable ({str(e)[:90]})")

# the tables themselves: the code alone decides, wherever the reply comes from
check(kind(okx.OKXError("51001", "Instrument ID doesn't exist.", "/api/v5/public/instruments")) == R.SYMBOL_UNAVAILABLE
      and kind(bn.BinanceError(-1121, "Invalid symbol.", "/api/v3/exchangeInfo")) == R.SYMBOL_UNAVAILABLE
      and kind(gt.GateioError("CONTRACT_NOT_FOUND", "", "/futures/usdt/contracts/X_USDT")) == R.SYMBOL_UNAVAILABLE
      and kind(bx.BingXError(109425, "X-USDT not exist", "/openApi/swap/v2/quote/contracts")) == R.SYMBOL_UNAVAILABLE
      and kind(sc.StockcoinError("x", code=-1121)) == R.SYMBOL_UNAVAILABLE
      and kind(sc.StockcoinError("x", code=sc.API_CLOSED)) == R.SYMBOL_UNAVAILABLE,
      "OKX 51001, Binance -1121, Gate.io CONTRACT_NOT_FOUND, BingX 109425, StockCoin -1121 / -1157 → symbol_unavailable")
check(by.BybitError("x", code=10001).code == 10001 and kind(by.BybitError("x", code=10001)) is None,
      "a Bybit 10001 built without the reply text is not classified (10001 is every parameter error)")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
