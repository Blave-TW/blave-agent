"""Bybit linear market orders: an order whose outcome is unknown is never sent twice and never
reported as a rejection — no network (requests.request / requests.get are faked).

What it protects (spec order-unknown-outcome 2026-10-29, Bybit):
- the order POST: a read timeout, a dropped connection after the request went out, a 5xx, a
  non-JSON 2xx, 10000 ("Server Timeout") / 10016 ("Server error") escaped as an error → recorded
  as 拒單 → the next round sent it again under a new orderLinkId;
- the confirm poll after an accepted order: any order read failure escaped as the error itself,
  and the poll timeout raised an OrderNotConfirmed lib/portfolio could not park.

Asserts: the POST goes out exactly once on each of those and raises a parkable OrderNotConfirmed
(canonical symbol, orderLinkId); a connect timeout, a refused socket, DNS, 10002 and 10006 are
still retried; a plain rejection is still BybitError; a poll that fails throughout ends in
OrderNotConfirmed with the order id; resolve_unknown_order through
venue_wiring.query_parked_order reads a fill / a no-fill by orderLinkId or orderId (realtime,
then history, then the executions around the park) and keeps an order Bybit cannot find
unknown; limit and spot POSTs keep the resend-with-orderLinkId transport; every request carries
referer Ue001036.

Run: cd blave-agent && .venv/bin/python tests/check_bybit_order_outcome_unknown.py
"""
import json
import os
import sys
import tempfile
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="bybit-unknown-"))

import requests  # noqa: E402
from lib import order_bybit as bb  # noqa: E402
from lib import portfolio, venue_wiring  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"BYBIT_API_KEY": "k", "BYBIT_SECRET_KEY": "s"}
clock = {"t": 1_000_000.0}
bb.time.time = lambda: clock["t"]
bb.time.sleep = lambda s: clock.__setitem__("t", clock["t"] + s)
bb._sync_time = lambda env: None
bb._position_rows = lambda env, symbol: []
_STOCK = {"AMDUSDT": "AMDSTOCKUSDT"}
bb._linear = lambda env, symbol: _STOCK.get(symbol, symbol)
for s in ("BTCUSDT", "AMDSTOCKUSDT"):
    bb._RULES_CACHE[("linear", s)] = {"step": "0.001", "min_qty": 0.001, "min_notional": 0,
                                      "contract_value": 1.0, "tick": "0.1", "equity": False}
bb._RULES_CACHE[("spot", "BTCUSDT")] = {"step": "0.000001", "min_qty": 0.000001, "min_amt": 1.0,
                                        "tick": "0.01"}


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else str(body)

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"HTTP {self.status_code}")


def bybit(result=None, code=0, msg="OK"):
    return Resp(200, {"retCode": code, "retMsg": msg, "result": result or {}})


CALLS = {"POST": [], "GET": [], "referer": set()}


def wire(posts, gets=None):
    """posts: list of a Resp / exception, consumed in order (last repeats). gets: either the
    same kind of list, or a function (path, query dict) → Resp / exception."""
    CALLS["POST"].clear()
    CALLS["GET"].clear()
    CALLS["referer"].clear()
    posts = list(posts)
    gq = gets if callable(gets) else None
    gl = list(gets or []) if not callable(gets) else None

    def nxt(q):
        x = q.pop(0) if len(q) > 1 else q[0]
        if isinstance(x, BaseException):
            raise x
        return x

    def request(method, url, headers=None, data=None, timeout=None):
        CALLS["referer"].add((headers or {}).get("referer"))
        if method == "POST":
            CALLS["POST"].append(json.loads(data))
            return nxt(posts)
        CALLS["GET"].append(url)
        if gq:
            u = urlparse(url)
            x = gq(u.path, {k: v[0] for k, v in parse_qs(u.query).items()})
            if isinstance(x, BaseException):
                raise x
            return x
        return nxt(gl)

    bb.requests.request = request
    bb.requests.get = lambda *a, **k: (_ for _ in ()).throw(AssertionError("no public GET expected"))


ACCEPTED = bybit({"orderId": "77", "orderLinkId": "rc1"})


def order_row(status, cum="0", avg="", oid="77", link="rc1"):
    return {"orderId": oid, "orderLinkId": link, "orderStatus": status, "qty": "0.01",
            "cumExecQty": cum, "avgPrice": avg, "cumExecFee": "0.01", "rejectReason": "EC_NoError"}


def rows(*r):
    return bybit({"list": list(r)})


FILLED = rows(order_row("Filled", "0.01", "67000"))
EMPTY = rows()


def place(symbol="BTCUSDT"):
    return bb.place_market_order(ENV, symbol, "long", 0.01, client_order_id="rc1")


def unknown_ok(e, order_id=None, symbol="BTCUSDT"):
    return (portfolio._outcome_unknown(e) and e.parkable() and e.venue == "bybit"
            and e.venue_symbol == symbol and e.client_order_id == "rc1"
            and (order_id is None or str(e.order_id) == order_id))


# ── the order POST ───────────────────────────────────────────────────────────
for label, post_answer in (
        ("a read timeout", requests.exceptions.ReadTimeout("read timed out")),
        ("a dropped connection after send", requests.exceptions.ConnectionError("RemoteDisconnected")),
        ("a ChunkedEncodingError", requests.exceptions.ChunkedEncodingError("IncompleteRead")),
        ("an SSL error", requests.exceptions.SSLError("EOF occurred in violation of protocol")),
        ("HTTP 503 (non-JSON)", Resp(503, None, "Service Unavailable")),
        ("HTTP 502 (JSON)", Resp(502, {"retCode": 10016, "retMsg": "Server error"})),
        ("HTTP 200 non-JSON", Resp(200, None, "<html>proxy</html>")),
        ("10000 Server Timeout", bybit(code=10000, msg="Server Timeout")),
        ("10016 Server error", bybit(code=10016, msg="Server error")),
        ("retCode 0 without an orderId", bybit({"orderLinkId": "rc1"})),
):
    wire([post_answer, ACCEPTED], [FILLED])
    try:
        place()
        check(False, f"POST {label}: must not return a fill")
    except bb.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and not CALLS["GET"] and unknown_ok(e) and e.order_id is None,
              f"POST {label}: sent once, parkable unknown outcome with the orderLinkId "
              f"({len(CALLS['POST'])} sends, venue_symbol {e.venue_symbol!r})")
    except Exception as e:
        check(False, f"POST {label}: raised {type(e).__name__}: {e} (reads as 拒單)")

wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    place("AMDUSDT")
    check(False, "stock perp POST read timeout: must raise")
except bb.OrderNotConfirmed as e:
    check(CALLS["POST"][0]["symbol"] == "AMDSTOCKUSDT" and unknown_ok(e, symbol="AMDUSDT"),
          f"stock perp: Bybit's name on the wire, the canonical symbol on the park ({e.venue_symbol})")

wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    bb.place_market_order(ENV, "BTCUSDT", "long", 0.01)
    check(False, "no caller id, POST read timeout: must not return a fill")
except bb.OrderNotConfirmed as e:
    sent_id = CALLS["POST"][0].get("orderLinkId")
    check(e.parkable() and sent_id and e.client_order_id == sent_id and len(sent_id) <= 36
          and sent_id.replace("-", "").replace("_", "").isalnum(),
          f"no caller id: the lib sends its own orderLinkId, so the unknown is still parkable ({sent_id})")

wire([requests.exceptions.ConnectTimeout("connect timed out"), ACCEPTED], [FILLED])
r = place()
check(r["executed_qty"] == 0.01 and len(CALLS["POST"]) == 2, "a connect timeout (nothing sent) is retried")
wire([bybit(code=10002, msg="invalid request, please check your server timestamp"), ACCEPTED], [FILLED])
r = place()
check(r["executed_qty"] == 0.01 and len(CALLS["POST"]) == 2, "10002 (refused at authentication) is re-signed and resent")
wire([bybit(code=10006, msg="Too many visits!"), ACCEPTED], [FILLED])
r = place()
check(r["executed_qty"] == 0.01 and len(CALLS["POST"]) == 2, "10006 (rate limited) is resent")
from urllib3.exceptions import MaxRetryError, NameResolutionError, NewConnectionError  # noqa: E402
for label, reason in (("a refused connection", NewConnectionError(None, "Connection refused")),
                      ("a DNS failure", NameResolutionError("api.bybit.com", None, OSError("nodename nor servname")))):
    refused = requests.exceptions.ConnectionError(MaxRetryError(None, "/v5/order/create", reason=reason))
    wire([refused, ACCEPTED], [FILLED])
    r = place()
    check(r["executed_qty"] == 0.01 and len(CALLS["POST"]) == 2, f"{label} (no socket, nothing sent) is retried")
    wire([refused], [FILLED])
    try:
        place()
        check(False, f"{label} every time must raise")
    except bb.OrderNotConfirmed:
        check(False, f"{label} every time: nothing was sent, not an unknown outcome")
    except requests.exceptions.ConnectionError:
        check(len(CALLS["POST"]) == 3, f"{label} every time: raised as is after the retries (a plain failure)")

wire([requests.exceptions.InvalidURL("bad url")], [FILLED])
try:
    place()
    check(False, "an invalid URL must raise")
except bb.OrderNotConfirmed:
    check(False, "an invalid URL never sent anything: not an unknown outcome")
except requests.exceptions.InvalidURL:
    check(len(CALLS["POST"]) == 1, "an invalid URL (nothing sent) raises as is")
wire([bybit(code=110007, msg="ab not enough for new order")], [FILLED])
try:
    place()
    check(False, "110007 must raise")
except bb.OrderNotConfirmed:
    check(False, "a plain rejection is not an unknown outcome")
except bb.BybitError as e:
    check(e.code == 110007 and len(CALLS["POST"]) == 1 and not portfolio._outcome_unknown(e),
          "a plain rejection is still BybitError, sent once, not an unknown outcome")

wire([ACCEPTED], [requests.exceptions.ConnectionError("reset"), FILLED])
o = bb.get_order(ENV, "BTCUSDT", "77")
check(o["status"] == "filled" and len(CALLS["GET"]) == 2, "a GET is still retried on a dropped connection")

# ── the confirm poll ─────────────────────────────────────────────────────────
for label, get_answer in (
        ("read timeouts", requests.exceptions.ReadTimeout("read timed out")),
        ("connection errors", requests.exceptions.ConnectionError("reset")),
        ("HTTP 502", Resp(502, None, "Bad Gateway")),
        ("10016", bybit(code=10016, msg="Server error")),
        ("not listed anywhere", EMPTY),
        ("New (not terminal)", rows(order_row("New"))),
):
    wire([ACCEPTED], [get_answer])
    try:
        place()
        check(False, f"poll {label}: must not return a fill")
    except bb.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and unknown_ok(e, "77"),
              f"poll {label} for the whole window: parkable OrderNotConfirmed with the order id, one POST")
    except Exception as e:
        check(False, f"poll {label}: raised {type(e).__name__}: {e} (reads as 拒單)")
wire([ACCEPTED], [requests.exceptions.ReadTimeout("t"), EMPTY, EMPTY, FILLED])
r = place()
check(r["executed_qty"] == 0.01 and r["avg_price"] == 67000.0 and len(CALLS["POST"]) == 1,
      "a read timeout, then not found, then Filled: the fill, one POST")
wire([ACCEPTED], [EMPTY, rows(order_row("Filled", "0.01", "67000"))])
r = place()
check(r["executed_qty"] == 0.01 and "/v5/order/history" in CALLS["GET"][1],
      "not in realtime, found in history: the fill")
wire([ACCEPTED], [rows(order_row("PartiallyFilledCanceled", "0.004", "67010"))])
r = place()
check(abs(r["executed_qty"] - 0.004) < 1e-12 and r["avg_price"] == 67010.0,
      "PartiallyFilledCanceled: returned with the partial (booked, not resent)")
wire([ACCEPTED], [rows(order_row("Cancelled", "0", ""))])
try:
    place()
    check(False, "cancelled with nothing filled must raise")
except bb.OrderNotConfirmed:
    check(False, "cancelled with nothing filled is known, not unknown")
except bb.BybitError as e:
    check(not portfolio._outcome_unknown(e), "cancelled with nothing filled: BybitError (a known no-fill)")

# open_position is a linear market order too: never resent, parked under the canonical symbol
wire([requests.exceptions.ReadTimeout("t"), ACCEPTED], [FILLED])
try:
    bb.open_position(ENV, "BTCUSDT", "long", 0.01, sl_price=60000, client_order_id="rc1")
    check(False, "open_position POST unknown must raise")
except bb.OrderNotConfirmed as e:
    check(len(CALLS["POST"]) == 1 and CALLS["POST"][0].get("stopLoss") and unknown_ok(e),
          "open_position POST read timeout: sent once, parkable")

# ── resolve_unknown_order, through the reconciler's own entry point ──────────
venue_wiring.read_env = lambda *a, **k: ENV


def query(order_id=None, cid="rc1", parked_at=None):
    return venue_wiring.query_parked_order({"venue": "bybit", "venue_symbol": "BTCUSDT", "order_id": order_id,
                                            "client_order_id": cid,
                                            "parked_at": clock["t"] - 600 if parked_at is None else parked_at})


def routed(realtime=EMPTY, history=EMPTY, executions=EMPTY):
    def g(path, q):
        CALLS.setdefault("q", []).append((path, q))
        return {"/v5/order/realtime": realtime, "/v5/order/history": history,
                "/v5/execution/list": executions}[path]
    CALLS["q"] = []
    return g


wire([ACCEPTED], routed(realtime=FILLED))
got = query()
check(got == (0.01, 67000.0) and CALLS["q"][0] == ("/v5/order/realtime", {"category": "linear", "orderLinkId": "rc1"}),
      f"parked by orderLinkId, filled: looked up by orderLinkId ({got}, {CALLS['q']})")
wire([ACCEPTED], routed(realtime=FILLED))
got = query(order_id="77")
check(got == (0.01, 67000.0) and CALLS["q"][0][1].get("orderId") == "77" and "orderLinkId" not in CALLS["q"][0][1],
      f"parked by order id, filled: by orderId ({got})")
wire([ACCEPTED], routed(history=FILLED))
check(query() == (0.01, 67000.0), "not in realtime (Bybit restarted), in history: the fill")
wire([ACCEPTED], routed(realtime=rows(order_row("Cancelled", "0", ""))))
check(query() == (0.0, 0.0), "terminal with nothing filled → (0, 0): released, nothing booked")
wire([ACCEPTED], routed(realtime=rows(order_row("Rejected", "0", ""))))
check(query() == (0.0, 0.0), "Rejected → (0, 0)")
wire([ACCEPTED], routed(realtime=rows(order_row("PartiallyFilledCanceled", "0.004", "67010"))))
check(query() == (0.004, 67010.0), "terminal after a partial fill → the partial")

ex = rows({"orderId": "77", "orderLinkId": "rc1", "execQty": "0.006", "execPrice": "67000", "execType": "Trade"},
          {"orderId": "77", "orderLinkId": "rc1", "execQty": "0.004", "execPrice": "67100", "execType": "Trade"},
          {"orderId": "55", "orderLinkId": "other", "execQty": "1", "execPrice": "1", "execType": "Trade"},
          {"orderId": "", "orderLinkId": "", "execQty": "0.01", "execPrice": "2", "execType": "Funding"})
wire([ACCEPTED], routed(executions=ex))
parked = clock["t"] - 600
got = query(parked_at=parked)
eq = [q for p, q in CALLS["q"] if p == "/v5/execution/list"]
check(got is not None and abs(got[0] - 0.01) < 1e-12 and abs(got[1] - 67040.0) < 1e-6,
      f"listed nowhere, executions carry our orderLinkId: their qty at VWAP, other orders left out ({got})")
check(eq and eq[0].get("orderLinkId") == "rc1" and eq[0].get("category") == "linear"
      and int(eq[0]["startTime"]) == int((parked - 300) * 1000) and int(eq[0]["endTime"]) == int((parked + 600) * 1000),
      f"executions read filtered by orderLinkId, window park −300 s … +600 s ({eq})")
wire([ACCEPTED], routed(executions=ex))
got = query(order_id="77")
eq = [q for p, q in CALLS["q"] if p == "/v5/execution/list"]
check(got is not None and abs(got[0] - 0.01) < 1e-12 and eq[0].get("orderId") == "77",
      f"by order id: executions filtered by orderId ({got})")
for label, routes in (
        ("listed nowhere, no executions", routed()),
        ("no executions of ours (other id, funding)", routed(executions=rows(ex._body["result"]["list"][2],
                                                                           ex._body["result"]["list"][3]))),
        ("a read timeout", lambda p, q: requests.exceptions.ReadTimeout("t")),
        ("HTTP 502", lambda p, q: Resp(502, None, "Bad Gateway")),
        ("10016 on the order read", lambda p, q: bybit(code=10016, msg="Server error")),
        ("executions read fails", routed(executions=requests.exceptions.ReadTimeout("t"))),
        ("still New", routed(realtime=rows(order_row("New")))),
        ("still PartiallyFilled", routed(realtime=rows(order_row("PartiallyFilled", "0.004", "67000")))),
        ("Filled without a price", routed(realtime=rows(order_row("Filled", "0.01", ""))))):
    wire([ACCEPTED], routes)
    check(query() is None, f"resolve: {label} → still unknown (kept parked)")
wire([ACCEPTED], routed(executions=ex))
check(bb.resolve_unknown_order(ENV, "BTCUSDT", client_order_id="rc1") is None,
      "resolve: listed nowhere and no park time → still unknown (no executions window)")
check(bb.resolve_unknown_order(ENV, "BTCUSDT") is None, "resolve: no id at all → None")
check(not CALLS["POST"], "resolve sends no POST")

# ── outside this batch: limit and spot keep the resend-with-orderLinkId transport ─
wire([requests.exceptions.ConnectionError("reset"), bybit(code=110072, msg="OrderLinkedID is duplicate")],
     [rows(order_row("New", oid="91", link="rc3"))])
got = bb.place_limit_order(ENV, "BTCUSDT", "long", 0.01, 67000, client_order_id="rc3")
check(len(CALLS["POST"]) == 2 and got["order_id"] == "91",
      f"limit: a dropped connection is resent with the same orderLinkId, 110072 resolved to the order ({got})")
wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    bb.place_limit_order(ENV, "BTCUSDT", "long", 0.01, 67000, client_order_id="rc3")
    check(False, "limit read timeout must raise")
except bb.OrderNotConfirmed:
    check(False, "limit read timeout: not parked by this batch")
except requests.exceptions.ReadTimeout:
    check(len(CALLS["POST"]) == 1, "limit read timeout: raised as before, sent once")
wire([ACCEPTED], [requests.exceptions.ReadTimeout("t")])
try:
    bb.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=10, client_order_id="rc4")
    check(False, "spot confirm poll failing throughout must raise")
except bb.OrderNotConfirmed as e:
    check(len(CALLS["POST"]) == 1 and portfolio._outcome_unknown(e) and not e.parkable(),
          "spot confirm poll unknown: an unknown outcome, not parkable (HALT, never queried as linear)")
wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    place()
except bb.OrderNotConfirmed:
    pass
check(CALLS["referer"] == {bb.BROKER_REFERER} and bb.BROKER_REFERER == "Ue001036",
      "broker attribution: every request carries referer Ue001036")

# half-updated workspace (lib/order_bybit.py landed, lib/unconfirmed.py not): the fallback base
# must take the same keywords, or the unknown POST would raise TypeError and read as a rejection
_src = open(os.path.join(ROOT, "lib", "order_bybit.py"), encoding="utf-8").read()
_fb = _src[_src.index("except ImportError:  # half-updated workspace: not parkable"):_src.index("class OrderNotConfirmed(")]
_ns = {}
exec("class _OutcomeUnknown(Exception):" + _fb.split("class _OutcomeUnknown(Exception):", 1)[1].replace("\n    ", "\n"), _ns)
_e = _ns["_OutcomeUnknown"]("x", venue="bybit", venue_symbol="BTCUSDT", client_order_id="c")
check(_e.client_order_id == "c" and _e.parkable() is False, "fallback base: same keywords, not parkable")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
