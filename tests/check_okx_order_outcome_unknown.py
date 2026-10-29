"""OKX swap market orders: an order whose outcome is unknown is never sent twice and never
reported as a rejection — no network (requests.post / requests.get are faked).

What it protects (spec order-unknown-outcome 2026-10-29, OKX):
- the order POST: a dropped connection was resent with the same clOrdId (OKX only refuses that
  while the order is not terminal, and a market order is terminal at once — measured live
  2026-08-05), a read timeout / 5xx / 50004 ("does not mean that the request was successful or
  failed") escaped as an error → recorded as 拒單 → the next round sent it again;
- the confirm poll after an accepted order: any get_order failure escaped as the error itself,
  and the poll timeout raised an OrderNotConfirmed lib/portfolio could not park.

Asserts: the POST goes out exactly once on each of those; it raises OrderNotConfirmed that
lib/portfolio treats as an unknown outcome, parkable, with the canonical symbol and the client
id; a connect timeout and 50102 are still retried; a plain rejection is still OKXError; a
poll that fails throughout ends in OrderNotConfirmed with the order id; a poll that fails and
then reads the fill returns it; resolve_unknown_order through venue_wiring.query_parked_order
reads a fill / a no-fill by clOrdId and keeps an order OKX cannot find unknown; spot and limit
unknowns are not parkable (not looked up as swap orders).

Run: cd blave-agent && .venv/bin/python tests/check_okx_order_outcome_unknown.py
"""
import os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="okx-unknown-"))

import requests  # noqa: E402
from lib import order_okx as ok  # noqa: E402
from lib import portfolio, venue_wiring  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"OKX_API_KEY": "k", "OKX_SECRET_KEY": "s", "OKX_PASSPHRASE": "p"}
clock = {"t": 1_000_000.0}
ok.time.time = lambda: clock["t"]
ok.time.sleep = lambda s: clock.__setitem__("t", clock["t"] + s)
ok._sync_time = lambda env: None
ok.get_position_mode = lambda env: "net_mode"
ok.format_qty = lambda env, symbol, qty, price=None: "1"
ok._rules_cache["BTC-USDT-SWAP"] = {"ct_val": 0.01, "lot_sz": "1", "min_sz": 1.0, "tick_sz": "0.1",
                                    "active": True, "equity": False}


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

    def get(url, headers=None, timeout=None):
        CALLS["GET"].append(url)
        return nxt(gets)

    ok.requests.post = post
    ok.requests.get = get


def okx(rows, code="0", msg=""):
    return Resp(200, {"code": code, "msg": msg, "data": rows})


ACCEPTED = okx([{"ordId": "77", "clOrdId": "rc1", "sCode": "0", "sMsg": ""}])


def order_row(state, fill_ct="0", avg="0", cancel_source=""):
    return okx([{"ordId": "77", "clOrdId": "rc1", "state": state, "sz": "1", "accFillSz": fill_ct,
                 "avgPx": avg, "fee": "-0.01", "feeCcy": "USDT", "cancelSource": cancel_source}])


FILLED = order_row("filled", "1", "67000")
NOT_FOUND = okx([], code="51603", msg="Order does not exist")


def place():
    return ok.place_market_order(ENV, "BTCUSDT", "long", 0.01, client_order_id="rc1")


def unknown_ok(e, order_id=None):
    return (portfolio._outcome_unknown(e) and e.parkable() and e.venue == "okx"
            and e.venue_symbol == "BTCUSDT" and e.client_order_id == "rc1"
            and (order_id is None or str(e.order_id) == order_id))


# ── the order POST ───────────────────────────────────────────────────────────
for label, post_answer in (
        ("a read timeout", requests.exceptions.ReadTimeout("read timed out")),
        ("a dropped connection after send", requests.exceptions.ConnectionError("RemoteDisconnected")),
        ("a ChunkedEncodingError", requests.exceptions.ChunkedEncodingError("IncompleteRead")),
        ("HTTP 503 (non-JSON)", Resp(503, None, "Service Unavailable")),
        ("HTTP 503 50001", Resp(503, {"code": "50001", "msg": "Service temporarily unavailable", "data": []})),
        ("HTTP 502 (non-JSON)", Resp(502, None, "Bad Gateway")),
        ("50004 top-level", okx([], code="50004", msg="Endpoint request timeout")),
        ("50004 in the row", okx([{"sCode": "50004", "sMsg": "Endpoint request timeout"}], code="1",
                                 msg="Operation failed")),
        ("HTTP 200 non-JSON", Resp(200, None, "<html>proxy</html>")),
        ("50004 in the row under code 0", okx([{"ordId": "", "sCode": "50004", "sMsg": "Endpoint request timeout"}])),
        ("51149 in the row", okx([{"sCode": "51149", "sMsg": "Order timed out"}], code="1", msg="Operation failed")),
        ("51149 HTTP 500", Resp(500, {"code": "51149", "msg": "Order timed out", "data": []})),
        ("50026 top-level", okx([], code="50026", msg="System error")),
        ("50001 top-level (HTTP 200)", okx([], code="50001", msg="Service temporarily unavailable")),
        ("code 0 without an ordId", okx([{"ordId": "", "clOrdId": "rc1", "sCode": "0"}])),
):
    wire([post_answer, ACCEPTED], [FILLED])
    try:
        place()
        check(False, f"POST {label}: must not return a fill")
    except ok.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and not CALLS["GET"] and unknown_ok(e) and e.order_id is None,
              f"POST {label}: sent once, parkable unknown outcome with the client id "
              f"({len(CALLS['POST'])} sends, venue_symbol {e.venue_symbol!r})")
    except Exception as e:
        check(False, f"POST {label}: raised {type(e).__name__}: {e} (reads as 拒單)")

wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    ok.place_market_order(ENV, "BTCUSDT", "long", 0.01)
    check(False, "no caller id, POST read timeout: must not return a fill")
except ok.OrderNotConfirmed as e:
    sent_id = __import__("json").loads(CALLS["POST"][0]).get("clOrdId")
    check(e.parkable() and sent_id and e.client_order_id == sent_id and sent_id.isalnum() and len(sent_id) <= 32,
          f"no caller id: the lib sends its own clOrdId, so the unknown is still parkable ({sent_id})")

wire([requests.exceptions.ConnectTimeout("connect timed out"), ACCEPTED], [FILLED])
r = place()
check(r["status"] == "filled" and len(CALLS["POST"]) == 2, "a connect timeout (nothing sent) is retried")
wire([okx([], code="50102", msg="Timestamp request expired"), ACCEPTED], [FILLED])
r = place()
check(r["status"] == "filled" and len(CALLS["POST"]) == 2, "50102 (refused at authentication) is re-signed and resent")
from urllib3.exceptions import MaxRetryError, NameResolutionError, NewConnectionError  # noqa: E402
for label, reason in (("a refused connection", NewConnectionError(None, "Connection refused")),
                      ("a DNS failure", NameResolutionError("www.okx.com", None, OSError("nodename nor servname")))):
    refused = requests.exceptions.ConnectionError(MaxRetryError(None, "/api/v5/trade/order", reason=reason))
    wire([refused, ACCEPTED], [FILLED])
    r = place()
    check(r["status"] == "filled" and len(CALLS["POST"]) == 2, f"{label} (no socket, nothing sent) is retried")
    wire([refused], [FILLED])
    try:
        place()
        check(False, f"{label} every time must raise")
    except ok.OrderNotConfirmed:
        check(False, f"{label} every time: nothing was sent, not an unknown outcome")
    except requests.exceptions.ConnectionError:
        check(len(CALLS["POST"]) == 3, f"{label} every time: raised as is after the retries (a plain failure)")

wire([requests.exceptions.InvalidURL("bad url")], [FILLED])
try:
    place()
    check(False, "an invalid URL must raise")
except ok.OrderNotConfirmed:
    check(False, "an invalid URL never sent anything: not an unknown outcome")
except requests.exceptions.InvalidURL:
    check(len(CALLS["POST"]) == 1, "an invalid URL (nothing sent) raises as is")
wire([okx([{"sCode": "51008", "sMsg": "Insufficient margin"}], code="1", msg="Operation failed")], [FILLED])
try:
    place()
    check(False, "51008 must raise")
except ok.OrderNotConfirmed:
    check(False, "a plain rejection is not an unknown outcome")
except ok.OKXError as e:
    check(str(e.code) == "51008" and len(CALLS["POST"]) == 1 and not portfolio._outcome_unknown(e),
          "a plain rejection is still OKXError, sent once, not an unknown outcome")

# reads before the POST keep their retry: a dropped connection on a GET is retried
wire([ACCEPTED], [requests.exceptions.ConnectionError("reset"), FILLED])
o = ok.get_order(ENV, "BTCUSDT", "77")
check(o["status"] == "filled" and len(CALLS["GET"]) == 2, "a GET is still retried on a dropped connection")

# ── the confirm poll ─────────────────────────────────────────────────────────
for label, get_answer in (
        ("read timeouts", requests.exceptions.ReadTimeout("read timed out")),
        ("connection errors", requests.exceptions.ConnectionError("reset")),
        ("HTTP 502", Resp(502, None, "Bad Gateway")),
        ("order does not exist", NOT_FOUND),
        ("live (not terminal)", order_row("live")),
):
    wire([ACCEPTED], [get_answer])
    try:
        place()
        check(False, f"poll {label}: must not return a fill")
    except ok.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and unknown_ok(e, "77"),
              f"poll {label} for the whole window: parkable OrderNotConfirmed with the order id, one POST")
    except Exception as e:
        check(False, f"poll {label}: raised {type(e).__name__}: {e} (reads as 拒單)")
wire([ACCEPTED], [requests.exceptions.ReadTimeout("t"), NOT_FOUND, FILLED])
r = place()
check(r["status"] == "filled" and r["executed_qty"] == 0.01 and len(CALLS["POST"]) == 1,
      "a read timeout, then not found, then FILLED: the fill (base units), one POST")

part = order_row("canceled", "0.4", "67010", cancel_source="14")
wire([ACCEPTED], [part])
r = place()
check(r.get("partial") is True and abs(r["executed_qty"] - 0.004) < 1e-12 and r["avg_price"] == 67010.0,
      "canceled after a partial fill: returned with executed_qty (booked, not resent)")
wire([ACCEPTED], [order_row("canceled", "0", "0", cancel_source="14")])
try:
    place()
    check(False, "canceled with nothing filled must raise")
except ok.OrderNotConfirmed:
    check(False, "canceled with nothing filled is known, not unknown")
except ok.OKXError as e:
    check(not portfolio._outcome_unknown(e), "canceled with nothing filled: OKXError (a known no-fill)")

# ── resolve_unknown_order, through the reconciler's own entry point ──────────
venue_wiring.read_env = lambda: ENV


def query(order_id=None, cid="rc1"):
    return venue_wiring.query_parked_order({"venue": "okx", "venue_symbol": "BTCUSDT", "order_id": order_id,
                                            "client_order_id": cid, "parked_at": clock["t"] - 600})


wire([ACCEPTED], [FILLED])
got = query()
check(got == (0.01, 67000.0) and "clOrdId=rc1" in CALLS["GET"][0] and "ordId=" not in CALLS["GET"][0].replace("clOrdId", ""),
      f"parked by client id, filled: looked up by clOrdId → base qty and price ({got}, {CALLS['GET']})")
wire([ACCEPTED], [FILLED])
got = query(order_id="77")
check(got == (0.01, 67000.0) and "ordId=77" in CALLS["GET"][0], f"parked by order id, filled: by ordId ({got})")
wire([ACCEPTED], [order_row("canceled", "0", "0")])
check(query() == (0.0, 0.0), "terminal with nothing filled → (0, 0): released, nothing booked")
wire([ACCEPTED], [part])
check(query() == (0.004, 67010.0), "terminal after a partial fill → the partial")
for label, ans in (("not found", NOT_FOUND), ("a read timeout", requests.exceptions.ReadTimeout("t")),
                   ("HTTP 502", Resp(502, None, "Bad Gateway")), ("still live", order_row("live")),
                   ("filled without a price", order_row("filled", "1", "0"))):
    wire([ACCEPTED], [ans])
    check(query() is None, f"resolve: {label} → still unknown (kept parked)")

# ── outside this batch: spot / limit unknowns are not parked as swap orders ──
wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    ok.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=10, client_order_id="rc2")
    check(False, "spot POST unknown must raise")
except ok.OrderNotConfirmed as e:
    check(len(CALLS["POST"]) == 1 and not e.parkable(),
          "spot POST unknown: sent once, not parkable (HALT, never queried as a swap order)")
ok.format_price = lambda env, symbol, price: "67000"
wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    ok.place_limit_order(ENV, "BTCUSDT", "long", 0.01, 67000, client_order_id="rc3")
    check(False, "limit POST unknown must raise")
except ok.OrderNotConfirmed as e:
    check(len(CALLS["POST"]) == 1 and not e.parkable(), "limit POST unknown: sent once, not parkable")

# ── SL/TP: an algo POST is never resent; found by algoClOrdId, else ProtectionFailed ─
def algo_wire(post_answer, pending):
    """pending(body) → the rows orders-algo-pending answers, given the POSTed algo body."""
    CALLS["POST"].clear()
    CALLS["GET"].clear()
    box = {}

    def post(url, data=None, headers=None, timeout=None):
        CALLS["POST"].append(data)
        box["body"] = __import__("json").loads(data)
        if isinstance(post_answer, BaseException):
            raise post_answer
        return post_answer

    def get(url, headers=None, timeout=None):
        CALLS["GET"].append(url)
        return okx(pending(box.get("body") or {}) if "orders-algo-pending" in url else [])

    ok.requests.post, ok.requests.get = post, get


landed = lambda b: [{"algoId": "A1", "algoClOrdId": b.get("algoClOrdId"), "instId": "BTC-USDT-SWAP"}]
algo_wire(requests.exceptions.ReadTimeout("t"), landed)
got = ok.place_protective_orders(ENV, "BTCUSDT", "long", sl_price=60000)
check(len(CALLS["POST"]) == 1 and got["sl"]["algoId"] == "A1",
      f"SL POST read timeout, the order is pending under our algoClOrdId: placed, sent once ({got})")
for label, answer in (("a read timeout", requests.exceptions.ReadTimeout("t")),
                      ("HTTP 502", Resp(502, None, "Bad Gateway")),
                      ("code 0 without an algoId", okx([{"algoId": "", "sCode": "0"}]))):
    algo_wire(answer, lambda b: [])
    try:
        ok.place_protective_orders(ENV, "BTCUSDT", "long", sl_price=60000)
        check(False, f"SL {label}, not pending: must raise")
    except ok.ProtectionFailed as e:
        check(len(CALLS["POST"]) == 1 and "Tell the user" in str(e) and "do not resubmit" not in str(e)
              and "algoClOrdId bl" in str(e) and len(CALLS["GET"]) == ok.ALGO_LOOKUP_READS,
              f"SL {label}, not pending: sent once, ProtectionFailed telling to check first ({e})")
algo_wire(okx([{"algoId": "A2", "sCode": "0"}]), lambda b: landed(b))
got = ok.place_protective_orders(ENV, "BTCUSDT", "long", sl_price=60000, verify=False)
check(got["sl"]["algoId"] == "A2" and "algoClOrdId" in CALLS["POST"][0], "a plain SL carries an algoClOrdId")

# half-updated workspace (lib/order_okx.py landed, lib/unconfirmed.py not): the fallback base must
# take the same keywords, or the unknown POST would raise TypeError and read as a rejection
_src = open(os.path.join(ROOT, "lib", "order_okx.py"), encoding="utf-8").read()
_fb = _src[_src.index("except ImportError:  # half-updated workspace: not parkable"):_src.index("class OrderNotConfirmed(")]
_ns = {}
exec("class _OutcomeUnknown(Exception):" + _fb.split("class _OutcomeUnknown(Exception):", 1)[1].replace("\n    ", "\n"), _ns)
_e = _ns["_OutcomeUnknown"]("x", venue="okx", venue_symbol="BTCUSDT", client_order_id="c")
check(_e.client_order_id == "c" and _e.parkable() is False, "fallback base: same keywords, not parkable")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
