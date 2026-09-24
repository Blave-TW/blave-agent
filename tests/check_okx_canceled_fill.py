"""Minimal check that an OKX market order canceled by the venue keeps what it filled — no network.

What it protects (demo run 2026-09-23): OKX cancels a market order whose
estimated fill runs into its price limit or 5% slippage guard (cancelSource 15,
"Your unfilled order was canceled because the estimated fill price exceeded the
price limit…"). The state is `canceled` even when part of it filled — OKX's
docs: "accFillSz may be non-zero". The lib raised "ended canceled" either way,
so a partial fill never reached the ledger (the next round would buy it again)
and open_position left that part without its stop.

Asserts, for spot and swap market orders: canceled with accFillSz > 0 returns
the fill (executed_qty, 'partial': True, the cancel source and reason);
canceled with nothing filled raises and names the venue's reason; a normal
fill is unchanged.

Run: cd blave-agent && .venv/bin/python tests/check_okx_canceled_fill.py
"""
import json, os, sys, tempfile

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="okx-cancel-"))  # guard's state/ lands here

from lib import order_okx  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p", "OKX_DEMO": "true"}
REASON = ("Your unfilled order was canceled because the estimated fill price exceeded the "
          "price limit or slipped beyond the best bid or ask price by at least 5%.")
ORDER = {}


def _fake(method, url, **k):
    path = url.split("www.okx.com", 1)[1]
    if path.startswith("/api/v5/trade/order") and method == "POST":
        body = {"code": "0", "data": [{"ordId": "77", "sCode": "0"}]}
    elif path.startswith("/api/v5/trade/order"):
        body = {"code": "0", "data": [ORDER]}
    elif path.startswith("/api/v5/account/config"):
        body = {"code": "0", "data": [{"acctLv": "2", "posMode": "net_mode"}]}
    elif path.startswith("/api/v5/public/instruments"):
        body = {"code": "0", "data": [{"ctVal": "0.1", "lotSz": "0.01", "minSz": "0.01",
                                       "tickSz": "0.01", "state": "live"}]}
    else:
        body = {"code": "0", "data": []}
    r = requests.Response()
    r.status_code, r._content, r.url = 200, json.dumps(body).encode(), url
    return r


requests.get = lambda url, **k: _fake("GET", url, **k)
requests.post = lambda url, **k: _fake("POST", url, **k)
order_okx.time.sleep = lambda s: None


def order(state, filled, src="", reason=""):
    ORDER.clear()
    ORDER.update({"ordId": "77", "state": state, "accFillSz": filled, "avgPx": "2750" if
                  float(filled) else "", "sz": "30", "fee": "-0.000001", "feeCcy": "ETH",
                  "cancelSource": src, "cancelSourceReason": reason})


def run(fn):
    try:
        return fn(), None
    except Exception as e:
        return None, e


spot_buy = lambda: order_okx.place_spot_market_order(ENV, "ETHUSDT", "buy", quote_qty=30)
swap_buy = lambda: order_okx.place_market_order(ENV, "ETHUSDT", "long", 0.1)

order("canceled", "0.004", "15", REASON)
res, err = run(spot_buy)
check(err is None and res["executed_qty"] == 0.004 and res.get("partial") is True
      and res["cancel_source"] == "15" and res["cancel_reason"] == REASON,
      f"spot: canceled after a partial fill returns the fill ({err or res['executed_qty']})")

order("canceled", "0", "15", REASON)
res, err = run(spot_buy)
check(isinstance(err, order_okx.OKXError) and "nothing filled" in str(err)
      and "cancelSource 15" in str(err) and "price limit" in str(err),
      f"spot: canceled with nothing filled raises with the venue's reason ({str(err)[:80]}…)")

order("canceled", "0.5", "15", REASON)  # contracts: 0.5 × ctVal 0.1 = 0.05 ETH
res, err = run(swap_buy)
check(err is None and abs(res["executed_qty"] - 0.05) < 1e-12 and res.get("partial") is True,
      f"swap: canceled after a partial fill returns the fill in base units ({err or res['executed_qty']})")

order("mmp_canceled", "0", "", "")
res, err = run(swap_buy)
check(isinstance(err, order_okx.OKXError) and "no reason given" in str(err),
      "swap: mmp_canceled with nothing filled raises")

order("filled", "0.011")
res, err = run(spot_buy)
check(err is None and res["executed_qty"] == 0.011 and "partial" not in res,
      "a normal fill is returned unchanged")

print("\nALL OK" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
