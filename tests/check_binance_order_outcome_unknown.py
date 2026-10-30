"""Binance USD-M futures: an order whose outcome is unknown is never sent twice and never
reported as a rejection — no network (requests.post / requests.request are faked).

What it protects (audit v034 P0-1 / P0-2 / P1-3):
- the confirm poll after an accepted order: a read timeout, a dropped connection, a 5xx or
  -1001 used to escape as the error itself → recorded as 拒單 → the next round sent it again;
- the order POST: a dropped connection was retried with the same newClientOrderId (Binance
  only refuses that while the order is OPEN — "A unique id among open orders" — and a market
  order is terminal at once), -1001 was retried too, a read timeout / HTTP 503 escaped as an
  error. Official USD-M docs: -1006 / -1007 "execution status unknown"; HTTP 503 "Unknown
  error…" "could have been a success";
- a market order that ended EXPIRED / CANCELED after a partial fill was a BinanceError, so the
  filled part was never booked.

Asserts: the POST goes out exactly once on each of those; it raises OrderNotConfirmed carrying
the client order id (parkable without an order id); a connect timeout (nothing sent) and -1021
are still retried; a plain rejection is still BinanceError; the poll failures end in
OrderNotConfirmed with the order id; a partial fill on a terminal order is returned;
get_order looks up by origClientOrderId; resolve_unknown_order reads FILLED, a cid that never
arrived (past the grace, no trades), and fills by order id from userTrades.

Run: cd blave-agent && .venv/bin/python tests/check_binance_order_outcome_unknown.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="binance-unknown-"))

import requests  # noqa: E402
from lib import order_binance as ob  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"BINANCE_API_KEY": "k", "BINANCE_SECRET_KEY": "s"}
clock = {"t": 1_000_000.0}
ob.time.time = lambda: clock["t"]
ob.time.sleep = lambda s: clock.__setitem__("t", clock["t"] + s)
ob.get_position_mode = lambda env: "oneway"
ob.format_qty = lambda env, symbol, qty, price=None: "0.001"
ob._order_commission = lambda env, symbol, order_id: (0.01, "USDT")


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
    posts, gets = list(posts), list(gets or [])

    def nxt(q):
        x = q.pop(0) if len(q) > 1 else q[0]
        if isinstance(x, BaseException):
            raise x
        return x

    def post(url, data=None, headers=None, timeout=None):
        CALLS["POST"].append(data)
        return nxt(posts)

    def request(method, url, headers=None, timeout=None):
        CALLS["GET"].append(url)
        return nxt(gets)

    ob.requests.post = post
    ob.requests.request = request


FILLED = Resp(200, {"orderId": 77, "status": "FILLED", "avgPrice": "67000", "executedQty": "0.001",
                    "origQty": "0.001", "clientOrderId": "x-52DDFAFNt"})


def place():
    return ob.place_market_order(ENV, "BTCUSDT", "long", 0.001, client_order_id="t1")


# ── P0-2: the order POST ─────────────────────────────────────────────────────
for label, post_answer in (
        ("a read timeout", requests.exceptions.ReadTimeout("read timed out")),
        ("a dropped connection after send", requests.exceptions.ConnectionError("RemoteDisconnected")),
        ("HTTP 503 (non-JSON)", Resp(503, None, "Service Unavailable")),
        ("HTTP 503 Unknown error", Resp(503, {"code": -1000, "msg": "Unknown error, please check your request or try again later."})),
        ("-1001 DISCONNECTED", Resp(400, {"code": -1001, "msg": "Internal error"})),
        ("-1007 TIMEOUT", Resp(408, {"code": -1007, "msg": "Timeout waiting for response from backend server."})),
        # re-audit R-P1: not ConnectionError subclasses — a body cut mid-transfer after Binance answered
        ("a ChunkedEncodingError", requests.exceptions.ChunkedEncodingError("Connection broken: IncompleteRead")),
        ("a ContentDecodingError", requests.exceptions.ContentDecodingError("bad gzip")),
        ("HTTP 200 non-JSON", Resp(200, None, "<html>proxy</html>")),
):
    wire([post_answer], [FILLED])
    try:
        place()
        check(False, f"POST {label}: must not return a fill")
    except ob.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and e.parkable() and e.order_id is None
              and e.client_order_id == "x-52DDFAFNt1" and e.venue_symbol == "BTCUSDT",
              f"POST {label}: sent once, OrderNotConfirmed carrying the client id ({len(CALLS['POST'])} sends)")
    except Exception as e:
        check(False, f"POST {label}: raised {type(e).__name__}: {e}")

wire([requests.exceptions.InvalidURL("bad url")], [FILLED])
try:
    place()
    check(False, "an invalid URL must raise")
except ob.OrderNotConfirmed:
    check(False, "an invalid URL never sent anything: not an unknown outcome")
except requests.exceptions.InvalidURL:
    check(len(CALLS["POST"]) == 1, "an invalid URL (nothing sent) raises as is")
wire([requests.exceptions.ConnectTimeout("connect timed out"), Resp(200, {"orderId": 77})], [FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2, "a connect timeout (nothing sent) is retried")
from urllib3.exceptions import MaxRetryError, NameResolutionError, NewConnectionError  # noqa: E402
for label, reason in (("a refused connection", NewConnectionError(None, "Connection refused")),
                      ("a DNS failure", NameResolutionError("fapi.binance.com", None, OSError("nodename nor servname")))):
    refused = requests.exceptions.ConnectionError(MaxRetryError(None, "/fapi/v1/order", reason=reason))
    wire([refused, Resp(200, {"orderId": 77})], [FILLED])
    r = place()
    check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2, f"{label} (no socket, nothing sent) is retried")
    wire([refused], [FILLED])
    try:
        place()
        check(False, f"{label} every time must raise")
    except ob.OrderNotConfirmed:
        check(False, f"{label} every time: nothing was sent, not an unknown outcome")
    except requests.exceptions.ConnectionError:
        check(len(CALLS["POST"]) == 3, f"{label} every time: raised as is after the retries (not parked)")
wire([Resp(400, {"code": -1021, "msg": "Timestamp outside recvWindow"}), Resp(200, {"orderId": 77})], [FILLED])
ob._sync_time = lambda env: None
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 2, "-1021 (refused before matching) is re-signed and resent")
wire([Resp(400, {"code": -2019, "msg": "Margin is insufficient."})], [FILLED])
try:
    place()
    check(False, "-2019 must raise")
except ob.OrderNotConfirmed:
    check(False, "a plain rejection is not an unknown outcome")
except ob.BinanceError as e:
    check(e.code == -2019 and len(CALLS["POST"]) == 1, "a plain rejection is still BinanceError, sent once")

# ── P0-1: the confirm poll ───────────────────────────────────────────────────
for label, get_answer in (
        ("read timeouts", requests.exceptions.ReadTimeout("read timed out")),
        ("connection errors after retries", requests.exceptions.ConnectionError("reset")),
        ("HTTP 502", Resp(502, None, "Bad Gateway")),
        ("-1001", Resp(400, {"code": -1001, "msg": "Internal error"})),
):
    wire([Resp(200, {"orderId": 77})], [get_answer])
    try:
        place()
        check(False, f"poll {label}: must not return a fill")
    except ob.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and str(e.order_id) == "77" and e.parkable()
              and e.client_order_id == "x-52DDFAFNt1",
              f"poll {label} for the whole window: OrderNotConfirmed with the order id, one POST")
    except Exception as e:
        check(False, f"poll {label}: raised {type(e).__name__}: {e}")
wire([Resp(200, {"orderId": 77})], [requests.exceptions.ReadTimeout("t"), FILLED])
r = place()
check(r["status"] == "FILLED" and len(CALLS["POST"]) == 1, "a read timeout then FILLED: the fill, one POST")

# ── P1-3: terminal after a partial fill ──────────────────────────────────────
part = Resp(200, {"orderId": 77, "status": "EXPIRED", "avgPrice": "67010", "executedQty": "0.0004",
                  "origQty": "0.001", "clientOrderId": "x"})
wire([Resp(200, {"orderId": 77})], [part])
r = place()
check(r["status"] == "EXPIRED" and r["executed_qty"] == 0.0004 and r["avg_price"] == 67010.0,
      "EXPIRED after a partial fill: returned with executed_qty (booked, not resent)")
wire([Resp(200, {"orderId": 77})], [Resp(200, {"orderId": 77, "status": "EXPIRED", "avgPrice": "0",
                                               "executedQty": "0", "origQty": "0.001"})])
try:
    place()
    check(False, "EXPIRED with nothing filled must raise")
except ob.OrderNotConfirmed:
    check(False, "EXPIRED with nothing filled is known, not unknown")
except ob.BinanceError:
    check(True, "EXPIRED with nothing filled: BinanceError")

# ── query by client id, resolve_unknown_order ───────────────────────────────
wire([Resp(200, {})], [FILLED])
o = ob.get_order(ENV, "BTCUSDT", client_order_id="x-52DDFAFNt1")
check(o["status"] == "FILLED" and "origClientOrderId=x-52DDFAFNt1" in CALLS["GET"][0]
      and "orderId=" not in CALLS["GET"][0].split("origClientOrderId")[0],
      "get_order(client_order_id=) queries origClientOrderId")
wire([Resp(200, {})], [FILLED])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="c") == (0.001, 67000.0),
      "resolve: found FILLED by client id → its qty and price")
NOT = Resp(400, {"code": -2013, "msg": "Order does not exist."})
now = clock["t"]
wire([Resp(200, {})], [NOT, Resp(200, [])])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="c", parked_at=now - 30, now=now) is None,
      "resolve: client id not found inside the grace → still unknown")
wire([Resp(200, {})], [NOT, Resp(200, [])])
ob._time_offset["ms"] = -90_000   # this machine's clock runs 90 s ahead of Binance
check(ob.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="c", parked_at=now - 600, now=now) == (0.0, 0.0)
      and f"startTime={int((now - 600 - 300) * 1000) - 90_000}" in CALLS["GET"][1],
      "resolve: client id not found past the grace and no trade since → never arrived; the trade window "
      "starts 300 s before the park, in Binance's time")
ob._time_offset["ms"] = 0
wire([Resp(200, {})], [NOT, Resp(200, [{"qty": "0.001", "price": "1"}])])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="c", parked_at=now - 600, now=now) is None,
      "resolve: …but a trade on the symbol since then → still unknown")
wire([Resp(200, {})], [requests.exceptions.ReadTimeout("t")])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=77) is None, "resolve: the query times out → unknown")
wire([Resp(200, {})], [NOT, Resp(200, [{"qty": "0.0006", "price": "100"}, {"qty": "0.0004", "price": "200"}])])
check(ob.resolve_unknown_order(ENV, "BTCUSDT", order_id=77) == (0.001, 140.0) and "orderId=77" in CALLS["GET"][1],
      "resolve: the order not readable but userTrades for its id has fills → those, at their VWAP")

# half-updated workspace (lib/order_binance.py landed, lib/unconfirmed.py not): the fallback base must
# take the same keywords, or the unknown POST would raise TypeError and read as a rejection
_src = open(os.path.join(ROOT, "lib", "order_binance.py"), encoding="utf-8").read()
_fb = _src[_src.index("except ImportError:  # half-updated workspace: not parkable"):_src.index("class OrderNotConfirmed(")]
_ns = {}
exec("class _OutcomeUnknown(Exception):" + _fb.split("class _OutcomeUnknown(Exception):", 1)[1].replace("\n    ", "\n"), _ns)
_e = _ns["_OutcomeUnknown"]("x", venue="binance", venue_symbol="BTCUSDT", client_order_id="c")
check(_e.client_order_id == "c" and _e.parkable() is False, "fallback base: same keywords, not parkable")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
