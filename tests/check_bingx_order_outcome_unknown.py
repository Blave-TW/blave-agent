"""BingX swap: a market order whose outcome is unknown is never sent twice and never reported
as a rejection — no network (requests.post / requests.request are faked), no keys.

What it protects (spec order-unknown-outcome-2026-10-29, BingX):
- the order POST: a dropped connection after the send was resent to the fallback domain under the
  same clientOrderID, 100500 was resent too, a read timeout (not a ConnectionError subclass) / a
  5xx / a non-JSON 2xx escaped as an error → recorded as 拒單 → the next round sent a new order;
- the confirm poll after an accepted order: a read timeout, a 5xx or 109421 (not visible yet)
  escaped as the error itself, the poll timeout was an OrderNotConfirmed nothing could park;
- a market order that ended CANCELED after a partial fill was a BingXError, the filled part lost.

Asserts: on each of those the POST goes out exactly once, to the primary domain only; it raises
an OrderNotConfirmed that is a lib.unconfirmed.OrderOutcomeUnknown, parkable, carrying the client
id and the strategy's symbol (BTCUSDT, not BTC-USDT); a connect timeout (nothing sent) still
moves to the fallback domain, 100421 and 100410 are still resent; a plain rejection is still
BingXError; a GET keeps its fallback; the poll failures end in OrderNotConfirmed with the order id;
a socket that never opened
(refused / DNS) is not an unknown outcome and moves to the fallback domain; limit and SL/TP POSTs
are not resent (an SL says it may or may not be on the book), spot POSTs still are; the string
orderID is read when orderId is missing; resolve_unknown_order reads by clientOrderId, falls back to
the fills since the park matched on the id, never books a fill without a price or an order still
filling, and never releases an order it cannot find;
venue_wiring.query_parked_order dispatches to it.

Run: cd blave-agent && .venv/bin/python tests/check_bingx_order_outcome_unknown.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="bingx-unknown-"))

import requests  # noqa: E402
from lib import order_bingx as ob, unconfirmed  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"BINGX_API_KEY": "k", "BINGX_SECRET_KEY": "s"}
clock = {"t": 1_000_000.0}
ob.time.time = lambda: clock["t"]
ob.time.sleep = lambda s: clock.__setitem__("t", clock["t"] + s)
ob.get_position_mode = lambda env: "oneway"
ob.format_qty = lambda env, symbol, qty, price=None: "0.001"
ob._sync_time = lambda env: None


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else str(body)

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


CALLS = {"POST": [], "GET": []}


def wire(posts, gets=None):
    """posts / gets: lists of a Resp or an exception instance, consumed in order (last repeats)."""
    CALLS["POST"].clear()
    CALLS["GET"].clear()
    posts, gets = list(posts), list(gets or [Resp(200, {"code": 0, "data": {}})])

    def nxt(q):
        x = q.pop(0) if len(q) > 1 else q[0]
        if isinstance(x, BaseException):
            raise x
        return x

    def post(url, data=None, headers=None, timeout=None):
        CALLS["POST"].append((url, data))
        return nxt(posts)

    def request(method, url, headers=None, timeout=None):
        CALLS["GET"].append(url)
        return nxt(gets)

    ob.requests.post = post
    ob.requests.request = request


def ok(data):
    return Resp(200, {"code": 0, "msg": "", "data": data})


def err(code, msg="x", status=200):
    return Resp(status, {"code": code, "msg": msg})


ACCEPTED = ok({"order": {"orderId": 1234567890123456789, "clientOrderId": "t1"}})


def order(status, qty="0.001", px="67000"):
    return ok({"order": {"orderId": 1234567890123456789, "status": status, "avgPrice": px,
                         "executedQty": qty, "origQty": "0.001", "clientOrderId": "t1"}})


FILLED = order("FILLED")
OID = "1234567890123456789"


def place(cid="t1"):
    return ob.place_market_order(ENV, "BTCUSDT", "long", 0.001, client_order_id=cid)


def posts_to(base):
    return [u for u, _ in CALLS["POST"] if u.startswith(base)]


check(issubclass(ob.OrderNotConfirmed, unconfirmed.OrderOutcomeUnknown),
      "OrderNotConfirmed is an OrderOutcomeUnknown (lib/portfolio parks it)")

# ── the order POST: sent once, never to the fallback, parkable by client id ──
for label, post_answer in (
        ("a read timeout", requests.exceptions.ReadTimeout("read timed out")),
        ("a dropped connection after send", requests.exceptions.ConnectionError("RemoteDisconnected")),
        ("a ChunkedEncodingError", requests.exceptions.ChunkedEncodingError("IncompleteRead")),
        ("a ContentDecodingError", requests.exceptions.ContentDecodingError("bad gzip")),
        ("HTTP 503 (non-JSON)", Resp(503, None, "Service Unavailable")),
        ("HTTP 504 (non-JSON)", Resp(504, None, "Gateway Timeout")),
        ("HTTP 500 (JSON)", Resp(500, {"code": 109500, "msg": "Internal server error"})),
        ("HTTP 200 non-JSON", Resp(200, None, "<html>proxy</html>")),
        ("HTTP 500 with a code outside the unknown set", Resp(500, {"code": 101204, "msg": "Insufficient margin"})),
        ("HTTP 502 empty body", Resp(502, None, "")),
        ("100500 System busy", err(100500, "System busy")),
        ("109201 submitted twice", err(109201)),
        ("109701 network request exception", err(109701)),
        ("109500 Internal server error", err(109500)),
        ("110500 Order system busy", err(110500)),
        ("101481 clientOrderID already used", err(101481)),
        ("code 0 without an orderId", ok({"order": {}})),
):
    wire([post_answer], [FILLED])
    try:
        place()
        check(False, f"POST {label}: must not return a fill")
    except ob.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and posts_to(ob.LIVE_URL) and not posts_to(ob.LIVE_FALLBACK)
              and e.parkable() and e.venue == "bingx" and e.order_id is None
              and e.client_order_id == "t1" and e.venue_symbol == "BTCUSDT" and not CALLS["GET"],
              f"POST {label}: sent once to the primary domain, parkable by client id "
              f"({len(CALLS['POST'])} sends, {e.venue_symbol}, {e.client_order_id})")
    except Exception as e:
        check(False, f"POST {label}: raised {type(e).__name__}: {e}")

from urllib3.exceptions import MaxRetryError, NameResolutionError, NewConnectionError  # noqa: E402


def never_opened(kind):
    reason = (NewConnectionError(None, "Connection refused") if kind == "refused"
              else NameResolutionError("open-api.bingx.com", None, OSError("nodename nor servname")))
    return requests.exceptions.ConnectionError(MaxRetryError(None, "/openApi/swap/v2/trade/order", reason))


for kind in ("refused", "dns"):
    wire([never_opened(kind), ACCEPTED], [FILLED])
    try:
        r = place()
        check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2 and len(posts_to(ob.LIVE_FALLBACK)) == 1,
              f"a socket that never opened ({kind}): nothing sent, the fallback domain is tried")
    except Exception as e:
        check(False, f"a socket that never opened ({kind}): raised {type(e).__name__}: {e}")
wire([never_opened("refused")], [FILLED])
try:
    place()
    check(False, "refused everywhere must raise")
except ob.OrderNotConfirmed:
    check(False, "refused everywhere never sent anything: not an unknown outcome")
except requests.exceptions.ConnectionError:
    check(len(CALLS["POST"]) == 6, f"refused everywhere: 3 × 2 domains, raised as is ({len(CALLS['POST'])})")

wire([requests.exceptions.ConnectTimeout("connect timed out"), ACCEPTED], [FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2 and len(posts_to(ob.LIVE_FALLBACK)) == 1,
      "a connect timeout (nothing sent) moves to the fallback domain")
wire([requests.exceptions.ConnectTimeout("connect timed out")], [FILLED])
try:
    place()
    check(False, "connect timeouts everywhere must raise")
except ob.OrderNotConfirmed:
    check(False, "connect timeouts everywhere never sent anything: not an unknown outcome")
except requests.exceptions.ConnectTimeout:
    check(len(CALLS["POST"]) == 6, f"connect timeouts everywhere: tried 3 × 2 domains, raised as is ({len(CALLS['POST'])})")
wire([requests.exceptions.InvalidURL("bad url")], [FILLED])
try:
    place()
    check(False, "an invalid URL must raise")
except ob.OrderNotConfirmed:
    check(False, "an invalid URL never sent anything: not an unknown outcome")
except requests.exceptions.InvalidURL:
    check(len(CALLS["POST"]) == 1, "an invalid URL (nothing sent) raises as is")
wire([err(100421, "timestamp mismatch"), ACCEPTED], [FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2, "100421 (refused at authentication) is re-signed and resent")
wire([err(100410, "rate limited"), ACCEPTED], [FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2, "100410 (rate limited before matching) is resent")
wire([err(101204, "Insufficient margin")], [FILLED])
try:
    place()
    check(False, "101204 must raise")
except ob.OrderNotConfirmed:
    check(False, "a plain rejection is not an unknown outcome")
except ob.BingXError as e:
    check(e.code == 101204 and len(CALLS["POST"]) == 1, "a plain rejection is still BingXError, sent once")
wire([Resp(403, None, "<html>forbidden</html>")], [FILLED])
try:
    place()
    check(False, "a 4xx page must raise")
except ob.OrderNotConfirmed:
    check(False, "a 4xx refusal is not an unknown outcome")
except ob.BingXError as e:
    check(e.code == 403 and len(CALLS["POST"]) == 1, "a non-JSON 4xx on the order POST: BingXError, sent once")

wire([ACCEPTED], [FILLED])
ob.place_market_order(ENV, "BTCUSDT", "long", 0.001)
cid = [kv.split("=", 1)[1] for kv in CALLS["POST"][0][1].split("&") if kv.startswith("clientOrderID=")]
check(cid and cid[0].isalnum() and cid[0] == cid[0].lower() and len(cid[0]) <= 40,
      f"no client_order_id passed: one is generated and sent ({cid})")

wire([ok({"order": {"orderID": OID}})], [FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 1 and "orderId=" + OID in CALLS["GET"][0],
      "the place answer carrying only the string orderID: confirmed by it")

wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    ob.close_position(ENV, "BTCUSDT", "long", 0.001, client_order_id="c1")
    check(False, "close: must not return a fill")
except ob.OrderNotConfirmed as e:
    check(e.venue_symbol == "BTCUSDT" and e.parkable() and len(CALLS["POST"]) == 1,
          f"close_position (hands over BTC-USDT): parked under the strategy's symbol ({e.venue_symbol})")

# limit (chase) and SL/TP POSTs: not resent either
ob.format_price = lambda env, symbol, price: "67000"
wire([requests.exceptions.ConnectionError("RemoteDisconnected")], [FILLED])
try:
    ob.place_limit_order(ENV, "BTCUSDT", "long", 0.001, 67000, client_order_id="l1", post_only=True)
    check(False, "limit: must not return")
except ob.OrderNotConfirmed as e:
    check(len(CALLS["POST"]) == 1 and not posts_to(ob.LIVE_FALLBACK) and e.client_order_id == "l1",
          f"a limit POST cut after the send: sent once, OrderNotConfirmed ({len(CALLS['POST'])})")
for label, ans in (("dropped connection", requests.exceptions.ConnectionError("RemoteDisconnected")),
                   ("read timeout", requests.exceptions.ReadTimeout("t"))):
    wire([ans], [FILLED])
    try:
        ob.place_protective_orders(ENV, "BTCUSDT", "long", sl_price=60000, verify=False)
        check(False, "protective: must raise")
    except ob.ProtectionFailed as e:
        check(len(CALLS["POST"]) == 1 and not posts_to(ob.LIVE_FALLBACK) and "may NOT be placed" in str(e)
              and "get_open_orders before re-placing" in str(e),
              f"an SL POST {label}: sent once, ProtectionFailed says it may or may not be on the book")

# spot keeps the old transport (second batch)
ob.get_spot_rules = lambda env, symbol: {"min_notional": 0.5, "step": "0.0001", "tick": "0.01",
                                         "min_qty": 0.0001, "active": True}
ob.get_spot_order = lambda env, symbol, order_id: {"status": "FILLED", "executed_qty": 0.0001,
                                                   "avg_price": 67000.0}
wire([requests.exceptions.ConnectionError("RemoteDisconnected"), ok({"orderId": 55})], [FILLED])
r = ob.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=10)
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2 and len(posts_to(ob.LIVE_FALLBACK)) == 1,
      "a spot POST dropped connection: still resent to the fallback domain (unchanged)")

# GETs keep their transport
wire([ACCEPTED], [requests.exceptions.ConnectionError("reset"), FILLED])
o = ob.get_order(ENV, "BTCUSDT", OID)
check(o["status"] == "FILLED" and len(CALLS["GET"]) == 2 and CALLS["GET"][1].startswith(ob.LIVE_FALLBACK),
      "a GET dropped connection still moves to the fallback domain")

# ── the confirm poll ─────────────────────────────────────────────────────────
for label, get_answer in (
        ("read timeouts", requests.exceptions.ReadTimeout("read timed out")),
        ("connection errors", requests.exceptions.ConnectionError("reset")),
        ("HTTP 502", Resp(502, None, "Bad Gateway")),
        ("100500", err(100500)),
        ("109421 not found", err(109421, "order does not exist")),
        ("NEW until the timeout", order("NEW", "0", "0")),
):
    wire([ACCEPTED], [get_answer])
    try:
        place()
        check(False, f"poll {label}: must not return a fill")
    except ob.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and str(e.order_id) == OID and e.parkable()
              and e.client_order_id == "t1" and e.venue_symbol == "BTCUSDT",
              f"poll {label} for the whole window: OrderNotConfirmed with the order id, one POST")
    except Exception as e:
        check(False, f"poll {label}: raised {type(e).__name__}: {e}")
wire([ACCEPTED], [requests.exceptions.ReadTimeout("t"), Resp(500, None, "x"), FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 1, "a read timeout, a 5xx, then FILLED: the fill, one POST")
wire([ACCEPTED], [err(109421, "order does not exist"), FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 1, "not found, then found FILLED: the fill, one POST")

wire([ACCEPTED], [order("CANCELED", "0.0004", "67010")])
r = place()
check(r["status"] == "CANCELED" and r["executed_qty"] == 0.0004 and r["avg_price"] == 67010.0,
      "CANCELED after a partial fill: returned with executed_qty (booked, not resent)")
wire([ACCEPTED], [order("CANCELED", "0", "0")])
try:
    place()
    check(False, "CANCELED with nothing filled must raise")
except ob.OrderNotConfirmed:
    check(False, "CANCELED with nothing filled is known, not unknown")
except ob.BingXError:
    check(True, "CANCELED with nothing filled: BingXError")

# ── query by client id, resolve_unknown_order ───────────────────────────────
wire([ACCEPTED], [FILLED])
o = ob.get_order(ENV, "BTCUSDT", client_order_id="t1")
check(o["status"] == "FILLED" and "clientOrderId=t1" in CALLS["GET"][0] and "orderId=" not in
      CALLS["GET"][0].replace("clientOrderId", ""), "get_order(client_order_id=) queries clientOrderId")
wire([ACCEPTED], [FILLED])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="t1") == (0.001, 67000.0),
      "resolve: found FILLED by client id → its qty and price")
wire([ACCEPTED], [order("CANCELED", "0", "0")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID) == (0.0, 0.0),
      "resolve: ended without a fill → 0 (released)")
wire([ACCEPTED], [order("NEW", "0", "0")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID) is None, "resolve: still open → unknown")
now = clock["t"]
wire([ACCEPTED], [err(109421, "order does not exist")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="t1", parked_at=now - 7 * 86400, now=now) is None,
      "resolve: client id not found, even a week on → still unknown (never released on a miss)")
wire([ACCEPTED], [requests.exceptions.ReadTimeout("t")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID) is None, "resolve: the query times out → unknown")
wire([ACCEPTED], [order("PARTIALLY_FILLED", "0.0004", "67000")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID) is None,
      "resolve: PARTIALLY_FILLED → still unknown (not booked and released early)")
wire([ACCEPTED], [order("FILLED", "0.001", "0")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID) is None,
      "resolve: FILLED without a price → unknown (never booked at 0)")

GONE = err(109421, "order does not exist")


def fills(*rows):
    return ok({"fill_orders": list(rows)})


wire([ACCEPTED], [GONE, fills({"orderId": OID, "volume": "0.0006", "price": "100"},
                              {"orderId": OID, "volume": "0.0004", "price": "200"},
                              {"orderId": "999", "volume": "5", "price": "1"})])
got = ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID, parked_at=now - 60, now=now)
check(got is not None and abs(got[0] - 0.001) < 1e-12 and abs(got[1] - 140.0) < 1e-9
      and "allFillOrders" in CALLS["GET"][1]
      and f"startTs={int((now - 60 - 300) * 1000)}" in CALLS["GET"][1],
      f"resolve: query cannot find it, its fills since the park are there → those, at their VWAP ({got})")
wire([ACCEPTED], [GONE, fills({"orderId": "999", "clientOrderId": "other", "volume": "5", "price": "1"})])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID, client_order_id="t1", parked_at=now - 60, now=now) is None,
      "resolve: only other orders' fills → still unknown (never released)")
wire([ACCEPTED], [GONE, fills({"orderId": "555", "clientOrderId": "T1", "volume": "0.002", "price": "50"})])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="t1", parked_at=now - 60, now=now) == (0.002, 50.0),
      "resolve: client id only, a fill carrying it (BingX lowercases ids) → that fill")
wire([ACCEPTED], [GONE, requests.exceptions.ReadTimeout("t")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID, parked_at=now - 60, now=now) is None,
      "resolve: the fills query fails → unknown")
wire([ACCEPTED], [GONE, fills({"orderId": OID, "volume": "0.001", "price": "100"})])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=OID) is None and len(CALLS["GET"]) == 1,
      "resolve: no park time → no fills window, unknown")

from lib import venue_wiring  # noqa: E402
venue_wiring.read_env = lambda: ENV
wire([ACCEPTED], [order("FILLED", "0.002", "66000")])
got = venue_wiring.query_parked_order({"venue": "bingx", "venue_symbol": "BTCUSDT", "order_id": None,
                                       "client_order_id": "t1", "parked_at": now})
check(got == (0.002, 66000.0) and "clientOrderId=t1" in CALLS["GET"][0],
      f"query_parked_order on a client-id-only BingX park: answered through resolve_unknown_order ({got})")

# half-updated workspace (lib/order_bingx.py landed, lib/unconfirmed.py not): the fallback base must
# take the same keywords, or the unknown POST would raise TypeError and read as a rejection
_src = open(os.path.join(ROOT, "lib", "order_bingx.py"), encoding="utf-8").read()
_fb = _src[_src.index("except ImportError:  # half-updated workspace: not parkable"):_src.index("class OrderNotConfirmed(")]
_ns = {}
exec("class _OutcomeUnknown(Exception):" + _fb.split("class _OutcomeUnknown(Exception):", 1)[1].replace("\n    ", "\n"), _ns)
_e = _ns["_OutcomeUnknown"]("x", venue="bingx", venue_symbol="BTCUSDT", client_order_id="c")
check(_e.client_order_id == "c" and _e.parkable() is False, "fallback base: same keywords, not parkable")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
