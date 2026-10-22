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
5. The real --trade flow, end to end, against a fake classic Bitget (the real lib.order_bitget,
   lib.account_bitget, lib.execute, lib.venue_wiring; every HTTP request answered in-process,
   sockets refused): it reaches T12 and leaves the account flat in its original position mode,
   with Wei's own trigger order and the clock untouched; a trigger order on the account stops
   it at the precheck.

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

    def account_mode(self, env):
        return "uta"


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

# classic account: trigger (normal_plan) and trailing (track_plan) orders have their own lists
A.account_mode = lambda env: "classic"
PLANS = {"normal_plan": [], "track_plan": [{"orderId": "t9", "symbol": "BTCUSDT", "planType": "track_plan",
                                            "side": "sell", "size": "0.002"}]}
asked = []


def plan_send(method, path, env, params=None, retries=3):
    asked.append((path, params.get("planType")))
    return {"entrustedList": PLANS[params["planType"]] or None}


O._send = plan_send
why = V.precheck({}, A, O)
check(sorted(t for _, t in asked) == ["normal_plan", "track_plan"] and len(why) == 1
      and why[0].startswith("open track_plan: BTCUSDT sell 0.002"),
      "classic: the precheck asks both plan lists; a trailing order alone stops the order steps", why)
PLANS["track_plan"], asked[:] = [], []
check(V.precheck({}, A, O) == [] and len(asked) == 2, "classic, both plan lists empty (null): bare")
O._send = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("HTTP 502"))
why = V.precheck({}, A, O)
check(len(why) == 2 and all("unreadable" in w for w in why), "classic: an unreadable plan list stops them too", why)
del A.account_mode

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

# ── 3b. T12 body fails with legs open: no switch back then, the cleanup retries it ──
mode["m"], sets[:] = "oneway", []
legs_open = {"v": False}


def failing_body():
    legs_open["v"] = True  # two legs opened, then a step raises
    raise RuntimeError("ProtectionFailed")


try:
    V.switch_and_restore(set_mode, lambda: mode["m"], lambda: not legs_open["v"], "hedge", say, failing_body)
    check(False, "the failing body propagates")
except RuntimeError:
    check(sets == ["hedge"] and mode["m"] == "hedge", "T12: a body failing with legs open does not switch back yet")
legs_open["v"] = False  # the cleanup closed them
check(V.restore_mode_after_cleanup((set_mode, lambda: mode["m"], "oneway"), lambda: True, say)
      and mode["m"] == "oneway" and sets == ["hedge", "oneway"],
      "…the cleanup's retry switches back and reads the original mode back", sets)
mode["m"] = "hedge"
check(V.restore_mode_after_cleanup((set_mode, lambda: mode["m"], "oneway"), lambda: False, say) is False,
      "…and reports it when the account is still not bare")

# ── emit survives a dead pipe ────────────────────────────────────────────────
import builtins, glob, io, tempfile  # noqa: E401,E402
real_print = builtins.print


def dead_pipe(*a, **k):
    raise BrokenPipeError(32, "Broken pipe")


logf = os.path.join(tempfile.mkdtemp(prefix="bvlog-"), "v.log")
V.open_log(logf)
builtins.print = dead_pipe
try:
    V.emit("[CLEANUP] still logged")
    ok_emit = True
except OSError:
    ok_emit = False
builtins.print = real_print
check(ok_emit and "still logged" in open(logf).read(), "emit: a broken stdout never raises; the log file keeps the line")

# ── 5. the real --trade flow against a fake classic Bitget ───────────────────
import json, signal, threading, time  # noqa: E401,E402
from datetime import datetime, timezone  # noqa: E402
from urllib.parse import parse_qsl, urlsplit  # noqa: E402

sys.path.insert(0, ROOT)
import requests  # noqa: E402
from lib import account_bitget as acct_mod, order_bitget as order_mod, venue_wiring as vw_mod  # noqa: E402,F401
from lib import execute as ex_mod  # noqa: E402,F401

clock = {"t": time.time()}


def _tick():  # every read moves the fake clock a little, as a real one does (clientOids embed it)
    clock["t"] += 0.0005
    return clock["t"]


time.time = _tick
time.sleep = lambda s: clock.__setitem__("t", clock["t"] + max(float(s), 0.001))
_real_wait = threading.Event.wait


def _fake_wait(self, timeout=None):  # the executors wait on an Event: advance the fake clock instead
    if timeout is not None:
        clock["t"] += max(float(timeout), 0.001)
    return self.is_set()


threading.Event.wait = _fake_wait
MARK = {"BTCUSDT": 82283.9, "NVDAUSDT": 217.99, "TWTSMUSDT": 73.53, "ACNSTOCKUSDT": 239.76}
STEP = {"BTCUSDT": "0.0001"}


class Bitget:
    def __init__(self):
        self.pos_mode = "hedge_mode"
        self.legs = {}  # (sym, side) -> qty
        self.orders = {}
        self.plans = {}
        self.wei_plans = []  # trigger / trailing orders of Wei's own
        self.n = 0
        self.posts = []

    def oid(self):
        self.n += 1
        return str(10000 + self.n)

    def book(self, sym):  # on the 0.01 tick the fake contracts carry
        m = MARK[sym]
        return round(m - 0.01, 2), round(m + 0.01, 2)

    def move(self, sym, side, qty, reduce):
        """side = the leg (long/short) the qty goes to (+ open, − close). Returns the qty done."""
        k = (sym, side)
        if reduce:
            qty = min(qty, self.legs.get(k, 0.0))
            self.legs[k] = round(self.legs.get(k, 0.0) - qty, 8)
        else:
            self.legs[k] = round(self.legs.get(k, 0.0) + qty, 8)
        if self.legs.get(k, 0) <= 1e-12:
            self.legs.pop(k, None)
        return qty

    def fill(self, o):
        sym, side, qty = o["symbol"], o["side"], float(o["size"])
        if self.pos_mode == "hedge_mode":
            leg = ("long" if side == "buy" else "short") if o.get("tradeSide") == "open" else \
                  ("long" if side == "buy" else "short")
            done = self.move(sym, leg, qty, o.get("tradeSide") == "close")
        else:
            opp = "short" if side == "buy" else "long"
            done = self.move(sym, opp, qty, True)
            if o.get("reduceOnly") != "YES" and qty - done > 1e-12:
                self.move(sym, "long" if side == "buy" else "short", qty - done, False)
            elif o.get("reduceOnly") == "YES":
                qty = done
        o.update(state="filled", baseVolume=str(qty), priceAvg=str(MARK[sym]), fee="-0.001")
        if not any(k[0] == sym for k in self.legs):  # the position is gone: Bitget drops its TP/SL
            self.plans = {i: p for i, p in self.plans.items() if p["symbol"] != sym}

    def rest(self):
        for o in self.orders.values():
            if o["state"] == "live":
                bid, ask = self.book(o["symbol"])
                px = float(o["price"])
                if (o["side"] == "buy" and px >= bid) or (o["side"] == "sell" and px <= ask):
                    self.fill(o)

    def handle(self, method, path, q):
        ok = lambda d: {"code": "00000", "msg": "success", "data": d}  # noqa: E731
        if path == "/fapi/v1/exchangeInfo":
            return 200, {"symbols": [{"symbol": "BTCUSDT", "underlyingType": "COIN", "baseAsset": "BTC"},
                                     {"symbol": "NVDAUSDT", "underlyingType": "EQUITY", "baseAsset": "NVDA"}]}
        if path == "/api/v3/account/settings":
            return 400, {"code": "40084", "msg": "You are in Classic Account mode", "data": None}
        if path == "/api/v2/public/time":
            return 200, ok({"serverTime": str(int(clock["t"] * 1000))})
        if path == "/api/v2/mix/market/contracts":
            rows = [{"symbol": s, "baseCoin": s[:-4], "quoteCoin": "USDT", "sizeMultiplier": STEP.get(s, "0.01"),
                     "minTradeNum": STEP.get(s, "0.01"), "minTradeUSDT": "5", "pricePlace": "2", "priceEndStep": "1",
                     "volumePlace": "4", "symbolStatus": "normal", "isRwa": "NO" if s == "BTCUSDT" else "YES",
                     "symbolType": "perpetual", "maxLever": "20"} for s in MARK]
            return 200, ok([r for r in rows if r["symbol"] == q.get("symbol", r["symbol"])])
        if path == "/api/v2/mix/market/ticker":
            bid, ask = self.book(q["symbol"])
            m = str(MARK[q["symbol"]])
            return 200, ok([{"symbol": q["symbol"], "lastPr": m, "markPrice": m, "bidPr": str(bid), "askPr": str(ask)}])
        if path == "/api/v2/spot/market/tickers":
            return 200, ok([])
        if path == "/api/v2/mix/account/account":
            return 200, ok({"marginCoin": "USDT", "posMode": self.pos_mode, "marginMode": "crossed",
                            "crossedMarginLeverage": getattr(self, "lev", "10")})
        if path == "/api/v2/mix/account/set-leverage":
            drift = getattr(self, "drift", 0)
            self.lev = "20" if drift else q["leverage"]  # drift: Bitget applies something else once
            self.drift = max(drift - 1, 0)
            return 200, ok({"crossMarginLeverage": self.lev})
        if path == "/api/v2/mix/account/accounts":
            a = getattr(self, "avail", "30")
            return 200, ok([{"marginCoin": "USDT", "accountEquity": a, "available": a, "unrealizedPL": "0"}])
        if path == "/api/v2/account/all-account-balance":
            return 200, ok([{"accountType": "futures", "usdtBalance": "30"}, {"accountType": "spot", "usdtBalance": "70"}])
        if path in ("/api/v2/spot/account/assets", "/api/v2/account/funding-assets"):
            return 200, ok([])
        if path == "/api/v2/spot/account/info":
            return 200, ok({"userId": "6188905811", "authorities": []})
        if path == "/api/v2/mix/position/all-position":
            self.rest()
            return 200, ok([{"symbol": s, "holdSide": side, "total": str(v), "available": str(v),
                             "markPrice": str(MARK[s]), "openPriceAvg": str(MARK[s]), "unrealizedPL": "0",
                             "marginSize": "1", "leverage": "10", "marginMode": "crossed"}
                            for (s, side), v in sorted(self.legs.items())])
        if path == "/api/v2/mix/account/set-position-mode":
            if self.legs or any(o["state"] == "live" for o in self.orders.values()):
                return 400, {"code": "40774", "msg": "has position or order", "data": None}
            self.pos_mode = q["posMode"]
            return 200, ok({"posMode": self.pos_mode})
        if path == "/api/v2/mix/order/place-order" and q.get("symbol") in getattr(self, "withheld", ()):
            return 400, {"code": "40092", "msg": "This service is currently unavailable due to applicable "
                         "regulatory requirements or account eligibility conditions.", "data": None}
        if path == "/api/v2/mix/order/place-order" and getattr(self, "broke", False):
            return 400, {"code": "40762", "msg": "The order amount exceeds the balance", "data": None}
        if path == "/api/v2/mix/order/place-order":
            if any(o.get("clientOid") == q.get("clientOid") for o in self.orders.values()):
                return 400, {"code": "25212", "msg": "Duplicate clientOid", "data": None}
            self.posts.append(dict(q))
            o = dict(q, orderId=self.oid(), state="live", baseVolume="0", priceAvg="", fee="0")
            self.orders[o["orderId"]] = o
            if q.get("orderType") == "market":
                self.fill(o)
            else:
                bid, ask = self.book(q["symbol"])
                cross = float(q["price"]) >= ask if q["side"] == "buy" else float(q["price"]) <= bid
                if cross and q.get("force") == "post_only":
                    o["state"] = "canceled"
                elif cross:
                    self.fill(o)
            return 200, ok({"orderId": o["orderId"], "clientOid": q.get("clientOid")})
        if path == "/api/v2/mix/order/detail":
            self.rest()
            o = self.orders.get(q.get("orderId")) or next(
                (x for x in self.orders.values() if x.get("clientOid") == q.get("clientOid")), None)
            return (200, ok(o)) if o else (400, {"code": "40109", "msg": "not found", "data": None})
        if path == "/api/v2/mix/order/orders-pending":
            self.rest()
            rows = [o for o in self.orders.values() if o["state"] == "live" and q.get("symbol") in (None, o["symbol"])]
            return 200, ok({"entrustedList": rows or None})
        if path == "/api/v2/mix/order/cancel-order":
            o = self.orders.get(q.get("orderId"))
            if not o or o["state"] != "live":
                return 400, {"code": "40768", "msg": "Order does not exist", "data": None}
            o["state"] = "canceled"
            return 200, ok({"orderId": o["orderId"]})
        if path == "/api/v2/mix/order/place-tpsl-order":
            i = self.oid()
            self.plans[i] = {"orderId": i, "clientOid": q.get("clientOid"), "symbol": q["symbol"],
                             "planType": q["planType"], "triggerPrice": q["triggerPrice"], "holdSide": q["holdSide"],
                             "side": q["holdSide"], "posSide": q["holdSide"]}
            return 200, ok({"orderId": i, "clientOid": q.get("clientOid")})
        if path == "/api/v2/mix/order/orders-plan-pending":
            if q.get("planType") in ("normal_plan", "track_plan"):
                rows = [p for p in self.wei_plans if p["planType"] == q["planType"]]
            else:
                rows = [p for p in self.plans.values() if q.get("symbol") in (None, p["symbol"])]
            return 200, ok({"entrustedList": rows or None})
        if path == "/api/v2/mix/order/cancel-plan-order":
            for x in q.get("orderIdList") or []:
                self.plans.pop(x.get("orderId"), None)
            return 200, ok({"successList": q.get("orderIdList"), "failureList": []})
        if path.startswith("/api/v2/spot/wallet/"):
            return 200, ok([])
        raise AssertionError(f"unmocked {method} {path}")


BG = Bitget()


def fake_adapter_send(self, req, **kw):
    u = urlsplit(req.url)
    q = dict(parse_qsl(u.query))
    if req.body:
        q.update(json.loads(req.body))
    status, body = BG.handle(req.method, u.path, q)
    r = requests.Response()
    r.status_code, r._content, r.url, r.request = status, json.dumps(body).encode(), req.url, req
    r.headers["Content-Type"] = "application/json"
    return r


requests.adapters.HTTPAdapter.send = fake_adapter_send
envdir = tempfile.mkdtemp(prefix="bvenv-")
envp = os.path.join(envdir, "fake.env")
with open(envp, "w") as f:
    f.write("BITGET_API_KEY=bg_not_a_real_key\nBITGET_SECRET_KEY=not-a-real-secret\nBITGET_PASSPHRASE=not\"real\\pass\n")
os.chmod(envp, 0o600)
today = datetime.fromtimestamp(clock["t"], timezone.utc).strftime("%Y-%m-%d")
here, argv0 = os.getcwd(), list(sys.argv)
builtins.input = lambda prompt="": "y"


def run_trade(extra=()):
    sys.argv = ["live_bitget_verify.py", "--env", envp, "--trade", "--confirm", today,
                "--log", os.path.join(envdir, "trade.log"), *extra]
    code = 0
    try:
        V.main()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 1
    except Exception as e:  # a crash is a FAIL below, not the end of this test
        code = f"crashed: {type(e).__name__}: {e}"
    finally:
        os.chdir(here)
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, signal.default_int_handler if sig == signal.SIGINT else signal.SIG_DFL)
    return code


BG.wei_plans = [{"orderId": "w1", "clientOid": "app", "symbol": "NVDAUSDT", "planType": "normal_plan",
                 "side": "buy", "size": "0.05", "triggerPrice": "200"}]
code = run_trade()
check(code == 3 and not BG.posts, "--trade with Wei's trigger order open: refused at the precheck (exit 3), nothing placed",
      code)
BG.wei_plans = []
open(os.path.join(envdir, "trade.log"), "w").close()
code = run_trade()
log = open(os.path.join(envdir, "trade.log"), encoding="utf-8").read()
check("[T12 mode after switching back (want the original)]" in log and '"read": "hedge"' in log,
      "--trade runs through T12 on the real modules and reads the original position mode back")
check(all(f"[T12 one-way {x}" in log for x in ("over-close long", "over-close short", "close long through",
                                                  "close short through"))
      and "[T12 one-way legs after the over-close (want []; an opposite leg" in log
      and not [l for l in log.splitlines() if l.startswith("[T12 one-way legs") and not l.endswith("[]")],
      "T12 in one-way: reduceOnly over-close and lib close for both directions, flat after each")
check("[T9 venue] \"bitget\"" in log or "[T9 venue] bitget" in log, "T9 ran (prefix on lib.venue_wiring, not lib.execute)")
check(code == 0 and not BG.legs and BG.pos_mode == "hedge_mode" and not BG.plans
      and not any(o["state"] == "live" for o in BG.orders.values()),
      "…and leaves the account flat, no own order or TP/SL, in its original mode", (code, BG.legs, BG.pos_mode))
check(len({p["clientOid"] for p in BG.posts}) == len(BG.posts),
      "every accepted order carries its own clientOid (the fake refuses a repeat with 25212, as T2 measures)",
      len(BG.posts) - len({p["clientOid"] for p in BG.posts}))
check(all(str(p.get("clientOid", "")).startswith(V.PREFIX) for p in BG.posts)
      and all(float(p["size"]) * MARK[p["symbol"]] <= V.MAX_ORDER_USDT + 1e-9 for p in BG.posts),
      "every order the flow sent carries the prefix and stays under the per-order cap",
      [(p["symbol"], p["size"]) for p in BG.posts if float(p["size"]) * MARK[p["symbol"]] > V.MAX_ORDER_USDT])
check("not\"real\\pass" not in log and "not-a-real-secret" not in log and "bg_not_a_real_key" not in log,
      "the log holds no key value (the passphrase's JSON-escaped form included)")
check("Traceback" not in log and "FAILED" not in log, "no step crashed", [l for l in log.splitlines() if "FAILED" in l][:3])
# Bitget unreachable from T12's first mode switch on: the cleanup cannot reach it, yet the .env
# (T9's, with the keys) is gone, the audit and the closing warnings are printed
BG.__init__()
BG.down_after_switch = True
orig_handle = Bitget.handle


def flaky(self, method, path, q):
    if getattr(self, "down", False):
        raise requests.exceptions.ConnectionError("network is down")
    out = orig_handle(self, method, path, q)
    if path == "/api/v2/mix/account/set-position-mode" and getattr(self, "down_after_switch", False):
        self.down = True
    return out


Bitget.handle = flaky
before = set(glob.glob(os.path.join(tempfile.gettempdir(), "bitget-live-*")))
open(os.path.join(envdir, "trade.log"), "w").close()
code = run_trade(["--only", "T9,T12"])
log = open(os.path.join(envdir, "trade.log"), encoding="utf-8").read()
left = [d for d in set(glob.glob(os.path.join(tempfile.gettempdir(), "bitget-live-*"))) - before
        if os.path.exists(os.path.join(d, ".env"))]
check(code == 2 and not left, "Bitget down mid-T12: exit 2 and no .env left behind", (code, left))
check("[audit]" in log and "NOT FLAT" in log and "NOT BACK IN THE ORIGINAL POSITION MODE" in log,
      "…the audit, NOT FLAT and NOT BACK are all printed",
      [l[:80] for l in log.splitlines() if l.startswith(("[audit", "NOT"))])
Bitget.handle = orig_handle

# the futures account short of margin: stopped before the cost bound, nothing placed
BG.__init__()
BG.avail = "5"
open(os.path.join(envdir, "trade.log"), "w").close()
code = run_trade()
log = open(os.path.join(envdir, "trade.log"), encoding="utf-8").read()
check(code == 3 and not BG.posts and "劃轉" in log and "Estimated cost" not in log,
      "available under twice the largest order: exit 3 before the cost bound, nothing placed", code)
# the venue refuses T1 for margin (40762, as Wei's run measured): cleanup, one line why, exit 4, no traceback
BG.__init__()
del BG.avail
BG.broke = True
open(os.path.join(envdir, "trade.log"), "w").close()
code = run_trade()
log = open(os.path.join(envdir, "trade.log"), encoding="utf-8").read()
check(code == 4 and "T1 被拒：保證金不足" in log and "（40762）" in log and "[audit]" in log and not BG.legs,
      "T1 refused with 40762: the cleanup runs, one line names why, exit 4 (no crash)",
      (code, [l for l in log.splitlines() if "被拒" in l]))

# TWTSM withheld from this account (40092, as Wei's run measured): T5 records it and every
# other step still runs on NVDA / BTC; the account ends flat in its mode, exit 0
BG.__init__()
del BG.broke
BG.withheld = {"TWTSMUSDT"}
open(os.path.join(envdir, "trade.log"), "w").close()
code = run_trade()
log = open(os.path.join(envdir, "trade.log"), encoding="utf-8").read()
check(code == 0 and "T5 TWTSMUSDT NOT TRADABLE ON THIS ACCOUNT (40092)" in log and "[T12 mode at the very end" not in log
      and "[T12 mode after switching back (want the original)]" in log and "此帳戶不可交易" in log
      and not BG.legs and BG.pos_mode == "hedge_mode",
      "40092 on TWTSM: marked not tradable, T6–T12 still run on NVDA, flat, original mode, exit 0", code)
check("[order_reject:symbol_unavailable]" in log and "跟策略本身無關" in log,
      "…the refusal is tagged symbol_unavailable and says it is Bitget's region / eligibility rule, not the strategy")
del BG.withheld

# R10: a leverage that reads back changed is set back and shouted about
BG.__init__()
BG.drift = 1
open(os.path.join(envdir, "trade.log"), "w").close()
sys.argv = ["live_bitget_verify.py", "--env", envp, "--noop-write", "--only", "R10",
            "--log", os.path.join(envdir, "trade.log")]
try:
    V.main()
finally:
    os.chdir(here)
log = open(os.path.join(envdir, "trade.log"), encoding="utf-8").read()
check(BG.lev == "10" and "R10 WARNING" in log and "!!! R10" in log and "NOT RESTORED" not in log,
      "R10: a changed leverage is set back to the original and warned about loudly", BG.lev)
sys.argv = argv0

print("\n" + ("all ok" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
