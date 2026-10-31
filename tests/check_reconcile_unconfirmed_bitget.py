"""A Bitget market order whose outcome is unknown, through real reconcile rounds, on a classic account
and on a UTA: parked, not reported as 拒單, not sent again; the next rounds query it and book the
fill once, or release it and send the order again — no network, no keys (requests.request faked).

The order path is the real one: lib.portfolio.reconcile → lib.venue_wiring.auto_place_order →
lib.order_bitget.place_market_order, and the park is queried through the real
venue_wiring.query_parked_order → order_bitget.resolve_unknown_order. Only the transport, the
account type, the contract rules, the mark and the account's position read are stubbed. Every
number is made up.

Asserts:
- classic, POST read timeout and the clientOid lookup cannot find it: one POST, an
  order_unconfirmed row (no plain rejection row), the "outcome unknown" notice and not
  "Order failed", parked by client id, no HALT; while Bitget cannot find it: no POST, still
  parked; found FILLED: booked once from Bitget's qty and price, park cleared, nothing sent that
  round or the next;
- UTA, POST 40010: parked; order-info then says 25204 (a UTA drops cancelled API orders after
  2 h) but the fills carry our clientOid: booked once from the fills;
- UTA, the confirm poll never reads the accepted order: parked by order id; then cancelled with
  nothing filled: released, nothing booked, the order is sent once more and fills — the book ends
  at the target, neither doubled nor missing.

Run: cd blave-agent && .venv/bin/python tests/check_reconcile_unconfirmed_bitget.py
"""
import json
import os
import socket
import sys
import tempfile
import time
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WS = tempfile.mkdtemp(prefix="reconcile-unconfirmed-bitget-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = WS
os.environ["BLAVE_AGENT_BASE"] = WS
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
for d in ("manager", "state", "strategies/btc_trend"):
    os.makedirs(os.path.join(WS, d), exist_ok=True)
os.symlink(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"))
sys.path.insert(0, ROOT)


def _no_real_env(event, args):
    if event == "open" and os.path.abspath(str(args[0])) == os.path.join(ROOT, ".env"):
        raise PermissionError("the repo .env must never be read by a test")


sys.addaudithook(_no_real_env)
os.chdir(WS)


def _no_net(*a, **k):
    raise AssertionError("network access in an offline test")


socket.socket.connect = _no_net
socket.create_connection = _no_net

import requests  # noqa: E402
from lib import guard, portfolio, unconfirmed, venue_wiring  # noqa: E402
import lib.order_bitget as bo  # noqa: E402
import lib.account_bitget as ba  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


MARK = 50_000.0
ENV = {"BITGET_API_KEY": "k", "BITGET_SECRET_KEY": "s", "BITGET_PASSPHRASE": "p"}
venue_wiring.read_env = lambda path=".env": dict(ENV)
venue_wiring.detect_venue = lambda env: "bitget"
venue_wiring._binance_class = lambda sym: "COIN"
ba.VERIFIED_MODES = frozenset({"uta", "classic"})
ba.SWITCH_HOLD_S = 0
ba.sync_time = lambda: None
MODE = {"api": "classic"}
ba.account_mode = lambda env, refresh=False: MODE["api"]
ba.uta_settings = lambda env: {"holdMode": "one_way_mode", "symbolConfigList": []}
POS = []   # what the account holds, base units
ba.get_positions = lambda env: [{"symbol": "BTCUSDT", "side": "long", "size": q, "mark_price": MARK}
                                for q in POS if q]
ba.leg_rows = lambda env, mode=None: [{"symbol": "BTCUSDT", "side": "long", "total": q, "available": q,
                                       "mark": MARK} for q in POS if q]
bo.sweep_orphan_stops = lambda env, positions=None: []
bo.venue_symbol = lambda symbol: str(symbol).upper()
bo.get_contract_rules = lambda env, symbol: {"step": "0.0001", "min_qty": 0.0001, "min_notional": 5.0,
                                             "contract_value": 1.0, "tick": "0.1", "equity": False,
                                             "status": "normal"}
bo.get_mark_price = lambda env, sym: MARK
_skew = {"s": 0.0}   # the confirm poll's sleeps advance its own clock, not the test's
bo.time = SimpleNamespace(time=lambda: time.time() + _skew["s"],
                          sleep=lambda s: _skew.__setitem__("s", _skew["s"] + s),
                          strftime=time.strftime, gmtime=time.gmtime)


class Resp:
    def __init__(self, body, status=200):
        self.status_code = status
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return json.loads(self.text)


def ok(data):
    return Resp({"code": "00000", "msg": "success", "requestTime": 1, "data": data})


def err(code, msg, status=400):
    return Resp({"code": code, "msg": msg, "requestTime": 1, "data": None}, status)


PLACE = {"classic": "/api/v2/mix/order/place-order", "uta": "/api/v3/trade/place-order"}
DETAIL = {"classic": "/api/v2/mix/order/detail", "uta": "/api/v3/trade/order-info"}
GONE = {"classic": err("40109", "The data of the order cannot be found"), "uta": err("25204", "Order does not exist")}
NET = {"post": None, "detail": lambda q: GONE[MODE["api"]], "fills": lambda q: ok({"list": [], "cursor": None})}
POSTS, GETS = [], []


def _request(method, url, headers=None, data=None, timeout=None, params=None):
    u = urlsplit(url)
    q = dict(parse_qsl(u.query))
    if method.upper() == "POST":
        POSTS.append(json.loads(data))
        x = NET["post"](POSTS[-1]) if callable(NET["post"]) else NET["post"]
    else:
        GETS.append((u.path, q))
        if u.path == "/api/v2/mix/account/account":
            x = ok({"posMode": "one_way_mode", "marginMode": "crossed"})
        elif u.path in DETAIL.values():
            x = NET["detail"](q)
        elif u.path == "/api/v3/trade/fills":
            x = NET["fills"](q)
        else:
            raise AssertionError(f"unmocked GET {u.path}")
    if isinstance(x, BaseException):
        raise x
    return x


requests.request = _request
requests.get = requests.post = _no_net


def order_row(api, cid, state, filled, avg, oid="88"):
    if api == "uta":
        return ok({"orderId": oid, "clientOid": cid, "category": "USDT-FUTURES", "symbol": "BTCUSDT",
                   "orderType": "market", "qty": filled, "cumExecQty": filled, "avgPrice": avg,
                   "orderStatus": state, "feeDetail": [{"feeCoin": "USDT", "fee": "-0.3"}]})
    return ok({"orderId": oid, "clientOid": cid, "symbol": "BTCUSDT", "size": filled, "baseVolume": filled,
               "priceAvg": avg, "fee": "-0.3", "state": state})


CFG = "manager/portfolio_config.json"
json.dump({"seeded_at": "2026-09-01T00:00:00", "own_only_basis": 1, "symbols": {}},
          open("manager/ledger_seed.json", "w"))
open("strategies/btc_trend/strategy.py", "w").write('MARKET = "swap"\n')
json.dump({"symbol": "BTCUSDT", "position": 1.0, "market": "swap", "updated_at": int(time.time())},
          open("strategies/btc_trend/state.json", "w"))


def amount(x):
    json.dump({"amounts": {"btc_trend": x}, "exchanges": {"btc_trend": "bitget"}}, open(CFG, "w"))


sent = []


def round_():
    del POSTS[:], GETS[:]

    def place(symbol, diff, spec=None, **kw):
        kw.pop("contributors", None)
        return venue_wiring.auto_place_order(symbol, diff, spec, **kw)

    portfolio.reconcile(get_positions_fn=venue_wiring.auto_get_positions, place_order_fn=place,
                        threshold=10, send_telegram_fn=sent.append)
    return len(POSTS)


def rows(kind=None):
    try:
        out = json.load(open("manager/order_errors.json"))
    except OSError:
        return []
    return [r for r in out if kind is None or r.get("kind") == kind]


def booked():
    out = []
    if os.path.exists("manager/orders.jsonl"):
        for x in open("manager/orders.jsonl"):
            if "unconfirmed_park_id" in x:
                out.append(json.loads(x))
    return out


def book_qty():
    return float((portfolio.ledger_positions().get("BTCUSDT") or {}).get("qty") or 0)


def parked(cid=None, oid=None):
    return next((e for e in unconfirmed.load().values()
                 if (cid and e.get("client_order_id") == cid) or (oid and e.get("order_id") == oid)), None)


def plain_rejections():
    return [r for r in rows() if not r.get("kind")]


# ── classic: POST read timeout → parked, not 拒單 ─────────────────────────────
amount(500)
NET["post"] = requests.exceptions.ReadTimeout("read timed out")
n = round_()
cid1 = POSTS[0].get("clientOid") if POSTS else None
p1 = parked(cid=cid1)
check(n == 1 and float(POSTS[0]["size"]) == 0.01 and POSTS[0]["orderType"] == "market",
      f"classic: the failing round sends one market POST of 0.01 BTC ({POSTS})")
check(len(rows("order_unconfirmed")) == 1 and not plain_rejections(),
      f"classic: an order_unconfirmed row, no plain rejection row ({rows()})")
check(any("下單結果不明" in x for x in sent) and not any("Order failed" in x or "拒單" in x for x in sent),
      f"classic: the notice says outcome unknown, not 下單失敗／拒單 ({sent})")
check(p1 is not None and p1["venue"] == "bitget" and p1["venue_symbol"] == "BTCUSDT" and p1["order_id"] is None,
      f"classic: parked by client id under bitget / BTCUSDT ({unconfirmed.load()})")
check(not guard.halted(), "classic: no HALT")

n = round_()
check(n == 0 and any(p == DETAIL["classic"] and q.get("clientOid") == cid1 for p, q in GETS) and parked(cid=cid1),
      f"classic: Bitget cannot find it yet: no POST, queried by clientOid, still parked ({n}, {GETS})")

NET["detail"] = lambda q: order_row("classic", cid1, "filled", "0.01", str(MARK))
POS[:] = [0.01]
n = round_()
b = booked()
check(len(b) == 1 and abs(b[0]["legs"][0]["executed_qty"] - 0.01) < 1e-12 and b[0]["legs"][0]["fill_price"] == MARK
      and not unconfirmed.load(), f"classic FILLED: booked once from Bitget's qty and price, park cleared ({b})")
check(n == 0 and abs(book_qty() - 0.01) < 1e-12, f"classic: …and that round sends nothing ({n}, book {book_qty()})")
check(round_() == 0 and len(booked()) == 1, "classic: the next round sends nothing either and books nothing more")

# ── UTA: POST 40010 → parked; order-info purged, the fills carry our clientOid ─
MODE["api"] = "uta"
amount(1000)
NET["post"] = err("40010", "Request timed out")
NET["detail"] = lambda q: GONE["uta"]
n = round_()
cid2 = POSTS[0].get("clientOid") if POSTS else None
check(n == 1 and cid2 and cid2 != cid1 and POSTS[0].get("category") == "USDT-FUTURES" and parked(cid=cid2)
      and not plain_rejections(), f"uta 40010: one v3 POST, parked, not a rejection ({n}, {rows()[-1:]})")
check(round_() == 0 and parked(cid=cid2) and len(booked()) == 1, "uta: still unknown: nothing sent, nothing booked")
NET["fills"] = lambda q: ok({"list": [
    {"execId": "e1", "orderId": "90", "clientOid": cid2, "symbol": "BTCUSDT", "execPrice": str(MARK), "execQty": "0.004"},
    {"execId": "e2", "orderId": "90", "clientOid": cid2, "symbol": "BTCUSDT", "execPrice": str(MARK), "execQty": "0.006"},
    {"execId": "e3", "orderId": "91", "clientOid": "someone-else", "symbol": "BTCUSDT", "execPrice": "1", "execQty": "9"},
], "cursor": None})
POS[:] = [0.02]
n = round_()
b = booked()
check(len(b) == 2 and abs(b[1]["legs"][0]["executed_qty"] - 0.01) < 1e-12 and b[1]["legs"][0]["fill_price"] == MARK
      and not unconfirmed.load() and n == 0,
      f"uta: order-info 25204, fills matched on clientOid: booked once from the fills, nothing sent ({b[-1:]})")
check(round_() == 0 and len(booked()) == 2 and abs(book_qty() - 0.02) < 1e-12,
      f"uta: the next round sends nothing and books nothing more (book {book_qty()})")
NET["fills"] = lambda q: ok({"list": [], "cursor": None})

# ── UTA: accepted, the confirm poll never reads it → parked by order id; then released ──
amount(1500)
NET["post"] = lambda body: ok({"orderId": "95", "clientOid": body["clientOid"]})
NET["detail"] = lambda q: GONE["uta"] if q.get("clientOid") else requests.exceptions.ReadTimeout("t")
n = round_()
p3 = parked(oid="95")
check(n == 1 and p3 is not None and p3["venue_symbol"] == "BTCUSDT" and not plain_rejections(),
      f"uta: accepted, poll never reads it: parked by order id 95, not a rejection ({unconfirmed.load()})")
cid3 = p3 and p3.get("client_order_id")
NET["detail"] = lambda q: (order_row("uta", cid3, "cancelled", "0", "", oid="95") if q.get("orderId") == "95"
                           else GONE["uta"] if q.get("clientOid") else order_row("uta", "x", "filled", "0.01", str(MARK), oid="96"))
NET["post"] = lambda body: ok({"orderId": "96", "clientOid": body["clientOid"]})
n = round_()
r3 = [r for r in rows("order_unconfirmed") if r.get("park_id") == "95"]
check(not unconfirmed.load() and len(booked()) == 2 and r3 and r3[0].get("released") is True
      and r3[0].get("filled") is False, f"uta: cancelled with nothing filled: released, nothing booked ({r3})")
check(n == 1 and POSTS[0].get("clientOid") not in (cid1, cid2, cid3),
      f"uta: …and the order is sent once more, under a new client id ({POSTS})")
POS[:] = [0.03]
n = round_()
check(n == 0 and abs(book_qty() - 0.03) < 1e-12,
      f"the book ends at the target: 0.03 BTC, neither doubled nor missing ({n}, {book_qty()})")

print("all checks passed" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
