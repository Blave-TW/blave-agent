"""Binance futures: -2013 on the confirm poll right after an accepted placement is
not a rejection — no network.

What it protects (live 2026-10-24, BTCUSDT): POST /fapi/v1/order returned an
orderId, GET /fapi/v1/order 0.18 s later answered -2013 "Order does not exist.",
confirm_order raised it as a BinanceError and the reconciler sent a P1 交易所拒單
for an order that had filled.

Asserts: -2013 then FILLED → place_market_order returns the fill, never sends a
second POST; -2013 for the whole window → OrderNotConfirmed (unknown, may have
filled), not BinanceError; any other error on the poll still raises BinanceError.

Run: cd blave-agent && .venv/bin/python tests/check_binance_order_not_visible.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="binance-2013-"))

from lib import order_binance as ob  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


NOT_EXIST = {"code": -2013, "msg": "Order does not exist."}
FILLED = {"orderId": 1173539174627, "status": "FILLED", "avgPrice": "67000",
          "executedQty": "0.001", "origQty": "0.001", "clientOrderId": "x-52DDFAFNt"}
CALLS = {"POST": 0, "GET": 0}


def run(get_replies, timeout=15):
    replies = list(get_replies)
    CALLS.update(POST=0, GET=0)

    def fake_send(method, path, env, params=None, signed=True, retries=3, spot=False,
                  plain_text=False):
        CALLS[method] += 1
        if method == "POST":
            return {"orderId": 1173539174627}
        body = replies.pop(0) if len(replies) > 1 else replies[0]
        if "code" in body:
            raise ob.BinanceError(body["code"], body["msg"], path)
        return dict(body)

    ob._send = fake_send
    return ob.place_market_order({}, "BTCUSDT", "short", 0.001, confirm_timeout=timeout)


ob.get_position_mode = lambda env: "oneway"
ob.format_qty = lambda env, symbol, qty, price=None: "0.001"
ob._order_commission = lambda env, symbol, order_id: (0.0268, "USDT")
clock = {"t": 1_000_000.0}
ob.time.time = lambda: clock["t"]
ob.time.sleep = lambda s: clock.__setitem__("t", clock["t"] + s)

try:
    r = run([NOT_EXIST, FILLED])
    check(r["status"] == "FILLED" and r["executed_qty"] == 0.001,
          "-2013 then FILLED → the fill is returned")
    check(CALLS["POST"] == 1 and CALLS["GET"] == 2, "one placement, re-queried once")
except Exception as e:
    check(False, f"-2013 then FILLED raised {type(e).__name__}: {e}")

try:
    run([NOT_EXIST])
    check(False, "-2013 for the whole window must not return a fill")
except ob.OrderNotConfirmed as e:
    check("-2013" in str(e) and CALLS["POST"] == 1,
          "-2013 for the whole window → OrderNotConfirmed, no second placement")
except Exception as e:
    check(False, f"-2013 for the whole window raised {type(e).__name__}, not OrderNotConfirmed")

try:
    run([{"code": -2019, "msg": "Margin is insufficient."}])
    check(False, "-2019 on the poll must raise")
except ob.BinanceError as e:
    check(e.code == -2019 and CALLS["GET"] == 1, "other poll errors still raise BinanceError")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
