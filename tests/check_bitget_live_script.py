"""tests/live_bitget_verify.py runs on Wei's MAIN Bitget account: its safety helpers, offline.

1. precheck: any position, open order or TP/SL — or an unreadable list — stops the order steps.
2. cleanup: only the script's own orders / TP/SL (clientOid prefix or an id Bitget gave one of
   its POSTs) on the symbols it traded are cancelled; legs closed only on those symbols, in
   pieces under the cap and never leaving a tail under the venue minimum; anything else is
   left alone.
3. switch_and_restore (T12): never switches on a non-bare account; the original position mode
   is set and READ back at the end, also when the body fails.
4. install_cap / prefix_cids: an order over the per-order cap or without the prefix is refused
   before the transport; an accepted one's id is remembered as the script's own.

Run: cd blave-agent && .venv/bin/python tests/check_bitget_live_script.py
"""
import importlib.util
import os
import socket
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _no_net(*a, **k):
    raise AssertionError("network access in an offline test")


socket.socket.connect = _no_net
socket.create_connection = _no_net

spec = importlib.util.spec_from_file_location("live_bitget_verify", os.path.join(ROOT, "tests", "live_bitget_verify.py"))
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


class Acct:
    def __init__(self):
        self.legs = []

    def leg_rows(self, env, mode=None):
        return [dict(p) for p in self.legs]


class Order:
    def __init__(self, acct):
        self.acct, self.orders, self.plans, self.log = acct, [], [], []
        self.fail = None

    def canonical_symbol(self, s):
        return s

    def get_open_orders(self, env, symbol=None):
        if self.fail:
            raise RuntimeError(self.fail)
        return [dict(o) for o in self.orders if symbol in (None, o["symbol"])]

    def get_open_algo_orders(self, env, symbol=None):
        return [dict(o) for o in self.plans if symbol in (None, o["symbol"])]

    def cancel_order(self, env, symbol, order_id=None):
        self.log.append(("cancel", symbol, order_id))
        self.orders = [o for o in self.orders if o["order_id"] != order_id]
        return {"status": "cancel_accepted"}

    def cancel_algo_order(self, env, symbol, order_id, plan_type=None):
        self.log.append(("cancel_plan", symbol, order_id))
        self.plans = [o for o in self.plans if o["order_id"] != order_id]
        return {"status": "cancel_accepted"}

    def close_position_partial(self, env, symbol, side, qty):
        self.log.append(("close", symbol, side, round(qty, 8)))
        for p in self.acct.legs:
            if p["symbol"] == symbol and p["side"] == side:
                p["total"] = round(p["total"] - qty, 8)
        self.acct.legs = [p for p in self.acct.legs if p["total"] > 0]
        return {"avg_price": 1.0}


said = []


def say(tag, x):
    said.append((tag, x))


# ── 1. precheck ──────────────────────────────────────────────────────────────
A = Acct()
O = Order(A)
check(V.precheck({}, A, O) == [], "a bare account passes the precheck")
A.legs = [{"symbol": "ETHUSDT", "side": "short", "total": 0.5}]
O.orders = [{"order_id": "9", "client_order_id": "app1", "symbol": "SOLUSDT", "side": "buy", "qty": 1}]
O.plans = [{"order_id": "7", "client_order_id": "", "symbol": "ETHUSDT", "stop_order_type": "pos_loss"}]
why = V.precheck({}, A, O)
check(len(why) == 3 and why[0].startswith("position: ETHUSDT") and why[1].startswith("open order: SOLUSDT")
      and why[2].startswith("open TP/SL: ETHUSDT"),
      "a position, an open order and a TP/SL each stop the order steps, listed", why)
A.legs, O.orders, O.plans = [], [], []
O.fail = "HTTP 500"
why = V.precheck({}, A, O)
check(len(why) == 1 and "unreadable" in why[0], "an unreadable list stops them too (unknown is not empty)", why)
O.fail = None

# ── 2. cleanup: only its own ─────────────────────────────────────────────────
A.legs = [{"symbol": "NVDAUSDT", "side": "long", "total": 0.08}, {"symbol": "BTCUSDT", "side": "long", "total": 0.01}]
O.orders = [{"order_id": "1", "client_order_id": V.PREFIX + "rc123", "symbol": "NVDAUSDT"},
            {"order_id": "2", "client_order_id": "", "symbol": "NVDAUSDT"},  # ours by the id Bitget gave
            {"order_id": "3", "client_order_id": "wei-app", "symbol": "NVDAUSDT"},
            {"order_id": "4", "client_order_id": V.PREFIX + "rc999", "symbol": "BTCUSDT"}]  # a symbol not traded
O.plans = [{"order_id": "p1", "client_order_id": V.PREFIX + "rc5", "symbol": "NVDAUSDT", "stop_order_type": "pos_loss"},
           {"order_id": "p2", "client_order_id": "", "symbol": "NVDAUSDT", "stop_order_type": "pos_profit"}]
own_ids = {"2"}
del said[:]
unclean = V.cleanup({}, A, O, {"NVDAUSDT"}, own_ids, say, lambda s: 0.05)
cancels = sorted(x[2] for x in O.log if x[0] in ("cancel", "cancel_plan"))
closes = [x for x in O.log if x[0] == "close"]
check(cancels == ["1", "2", "p1"], "cleanup cancels only its own orders / TP/SL (prefix or own id)", cancels)
check({o["order_id"] for o in O.orders} == {"3", "4"} and [p["order_id"] for p in O.plans] == ["p2"],
      "…another clientOid, a TP/SL without one and a symbol it never traded are left alone")
check(closes == [("close", "NVDAUSDT", "long", 0.05), ("close", "NVDAUSDT", "long", 0.03)],
      "legs close only on the traded symbol, in pieces under the per-order cap", closes)
check(A.legs == [{"symbol": "BTCUSDT", "side": "long", "total": 0.01}], "the BTC leg it never traded is untouched", A.legs)
check(unclean == [] and any("NOT OURS" in t for t, _ in said), "clean result; what it left alone is listed", unclean)

# a tail under the venue minimum is never left: 0.08 in pieces of 0.05 with a 0.04 minimum
MIN = 0.04
real_close = O.close_position_partial
O.close_position_partial = lambda env, sym, side, qty: False if qty < MIN - 1e-12 else real_close(env, sym, side, qty)
A.legs = [{"symbol": "NVDAUSDT", "side": "long", "total": 0.08}]
del O.log[:]
done = V.close_chunked({}, O, "NVDAUSDT", "long", 0.08, 0.05, say, "T4", MIN)
pieces = [x[3] for x in O.log if x[0] == "close"]
check(done and A.legs == [] and all(q >= MIN for q in pieces) and all(q <= 0.05 for q in pieces),
      "pieces under the cap, none under the minimum: the leg closes to zero", pieces)
A.legs = [{"symbol": "NVDAUSDT", "side": "long", "total": 0.07}]
del O.log[:]
done = V.close_chunked({}, O, "NVDAUSDT", "long", 0.07, 0.05, say, "T4", 0.04)
check(len([x for x in O.log if x[0] == "close"]) == 1, "a leg that cannot split above the minimum is one close", O.log)
O.close_position_partial = lambda env, sym, side, qty: False
A.legs = [{"symbol": "NVDAUSDT", "side": "long", "total": 0.1}]
check(V.close_chunked({}, O, "NVDAUSDT", "long", 0.1, 0.05, say, "T4", MIN) is False,
      "a piece the lib does not send stops the loop and reports it")
O.close_position_partial = real_close
A.legs = []

# ── 3. T12: switch, read back, restore ───────────────────────────────────────
mode = {"m": "oneway"}
sets = []


def set_mode(m):
    sets.append(m)
    mode["m"] = m
    return {"ok": True}


ran = []
ok = V.switch_and_restore(set_mode, lambda: mode["m"], lambda: True, "hedge", say, lambda: ran.append(mode["m"]))
check(ok and sets == ["hedge", "oneway"] and ran == ["hedge"] and mode["m"] == "oneway",
      "T12: the body runs in the other mode, the original mode is set and read back", (sets, ran))
del sets[:]
ok = V.switch_and_restore(set_mode, lambda: mode["m"], lambda: False, "hedge", say, lambda: ran.append("x"))
check(sets == [] and ran == ["hedge"], "T12: a non-bare account is never switched")
try:
    V.switch_and_restore(set_mode, lambda: mode["m"], lambda: True, "hedge", say, lambda: 1 / 0)
    check(False, "a failing body propagates")
except ZeroDivisionError:
    check(sets == ["hedge", "oneway"] and mode["m"] == "oneway", "T12: a failing body still switches back")
del sets[:], said[:]


def stuck(m):  # Bitget takes the switch out, refuses the one back
    sets.append(m)
    if m == "hedge":
        mode["m"] = "hedge"
        return {"ok": True}
    return {"code": "40774"}


ok = V.switch_and_restore(stuck, lambda: mode["m"], lambda: True, "hedge", say, lambda: None)
check(ok is False and any("NOT BACK" in t for t, _ in said),
      "T12: a switch back that does not read back is reported, never assumed", said[-2:])
mode["m"] = "oneway"

# ── 4. cap + prefix ──────────────────────────────────────────────────────────
sent = []


class Mod:
    @staticmethod
    def _send(method, path, env, params=None, retries=3):
        sent.append((method, path, dict(params or {})))
        return {"orderId": "777"}

    @staticmethod
    def _cid(client_order_id=None):
        return client_order_id or "rc261022000000000001"


ids = set()
V.install_cap(Mod, lambda vsym: 180.0, ids)
V.prefix_cids(Mod)
check(Mod._cid().startswith(V.PREFIX) and Mod._cid("given") == "given", "minted clientOids carry the prefix; a given one is kept")
for label, body in (("over the cap", {"symbol": "NVDAUSDT", "qty": "0.06", "clientOid": V.PREFIX + "a"}),
                    ("over the cap at its limit price", {"symbol": "NVDAUSDT", "size": "0.04", "price": "300",
                                                         "clientOid": V.PREFIX + "b"}),
                    ("without the prefix", {"symbol": "NVDAUSDT", "qty": "0.03", "clientOid": "rc1"})):
    try:
        Mod._send("POST", "/api/v3/trade/place-order", {}, body)
        check(False, f"an order {label} is refused")
    except RuntimeError:
        check(not sent, f"an order {label} is refused before the transport")
Mod._send("POST", "/api/v2/mix/order/place-order", {}, {"symbol": "NVDAUSDT", "size": "0.04", "clientOid": V.PREFIX + "c"})
Mod._send("GET", "/api/v3/trade/order-info", {}, {"orderId": "1"})
check(len(sent) == 2 and ids == {"777"}, "an order under the cap goes out and its id is remembered as ours; reads pass", ids)

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
