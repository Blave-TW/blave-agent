"""StockCoin market orders: an order whose outcome is unknown is never sent twice and never
reported as a rejection — no network (requests.request is faked).

What it protects (spec order-unknown-outcome 2026-10-29, StockCoin):
- the order POST: a dropped connection, a read timeout or a 5xx was looked up once by
  clientOrderId and, when the query side had not caught up, the original error escaped →
  recorded as 拒單 → the next round sent the order again under a new id;
- the confirm poll after an accepted order: any get_order failure escaped as the error itself,
  and the poll timeout raised an OrderNotConfirmed lib/portfolio could not park.

Asserts: the POST goes out exactly once on each of those; it raises OrderNotConfirmed that
lib/portfolio treats as an unknown outcome, parkable, with the canonical symbol and the client
id; an order the lookup finds is confirmed instead; a connect timeout, a refused connection,
-1021 and -1003 are still retried; a plain rejection is still StockcoinError; a poll that fails
throughout ends in OrderNotConfirmed with the order id; a multiplier mismatch is never polled
past; resolve_unknown_order through venue_wiring.query_parked_order reads a fill / a no-fill by
orderId or clientOrderId, never releases on -2013, finds a -2013 order in the order history or
its fills, and cancels nothing (read-only); limit / STOP unknowns are not parkable.

Run: cd blave-agent && .venv/bin/python tests/check_stockcoin_order_outcome_unknown.py
"""
import json
import os
import sys
import tempfile
import time as _time
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="stockcoin-unknown-"))
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = os.getcwd()

import requests  # noqa: E402
from urllib3.exceptions import MaxRetryError, NameResolutionError, NewConnectionError  # noqa: E402
from lib import order_stockcoin as sc  # noqa: E402
from lib import portfolio, venue_wiring  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"STOCKCOIN_API_KEY": "k", "STOCKCOIN_SECRET_KEY": "s"}
clock = {"t": 1_000_000.0}
sc.time = SimpleNamespace(time=lambda: clock["t"], sleep=lambda s: clock.__setitem__("t", clock["t"] + s),
                          strftime=_time.strftime, gmtime=_time.gmtime)
sc._sync_time = lambda env: None
_real_rules = sc.get_contract_rules
sc.get_contract_rules = lambda env, symbol: {"step": "1", "min_qty": 0.0001, "min_notional": 0.0,
                                             "contract_value": 0.0001}
sc._available = lambda env, vsym, direction: 10


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else ("" if body is None else json.dumps(body))

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


CALLS = []
NET = {}


def wire(post, order=None, history=None, trades=None):
    """post / order: a Resp, an exception, or a list of them consumed in order (last repeats).
    order answers GET /futures/order (the lookup and the poll); history / trades their lists."""
    del CALLS[:]
    NET.update(post=list(post) if isinstance(post, list) else [post],
               order=list(order) if isinstance(order, list) else [order if order is not None else NOT_FOUND],
               history=history or [], trades=trades or [])


def nxt(q):
    x = q.pop(0) if len(q) > 1 else q[0]
    if isinstance(x, BaseException):
        raise x
    return x(CALLS[-1]) if callable(x) else x


def fake_request(method, url, headers=None, data=None, timeout=None):
    u = urlsplit(url)
    CALLS.append({"method": method, "path": u.path, "query": dict(parse_qsl(u.query)),
                  "body": dict(parse_qsl(data)) if data else {}})
    if method == "POST":
        return nxt(NET["post"])
    if u.path.endswith("/futures/order"):
        return nxt(NET["order"])
    if u.path.endswith("/futures/orders/history"):
        return Resp(200, NET["history"])
    if u.path.endswith("/futures/trades"):
        return Resp(200, NET["trades"])
    if u.path.endswith("/futures/orders/open"):
        return Resp(200, [])
    if u.path.endswith("/futures/positions"):
        return Resp(200, [])
    raise AssertionError(f"unmocked {method} {u.path}")


sc.requests.request = fake_request


def row(status="FILLED", executed="5", avg="180.5", oid="9001", cid="rc1", side="BUY_OPEN"):
    return {"orderId": oid, "clientOrderId": cid, "symbol": "NVDA-PERP-USDT", "side": side,
            "status": status, "executedQty": executed, "origQty": "5", "avgPrice": avg,
            "contractMultiplier": "0.0001"}


ACCEPTED = Resp(200, row(status="NEW", executed="0", avg="0"))
FILLED = Resp(200, row())
NOT_FOUND = Resp(400, {"code": -2013, "msg": "Order does not exist"})


def posts():
    return [c for c in CALLS if c["method"] == "POST"]


def place(cid="rc1", **kw):
    return sc.place_market_order(ENV, "NVDAUSDT", "long", 0.0005, client_order_id=cid, **kw)


def unknown_ok(e, order_id=None, cid="rc1"):
    return (portfolio._outcome_unknown(e) and e.parkable() and e.venue == "stockcoin"
            and e.venue_symbol == "NVDAUSDT" and e.client_order_id == cid
            and (order_id is None or str(e.order_id) == order_id))


# ── the order POST: not found by its clientOrderId → parkable, sent once ─────
for label, answer in (
        ("a read timeout", requests.exceptions.ReadTimeout("read timed out")),
        ("a dropped connection after send", requests.exceptions.ConnectionError("RemoteDisconnected")),
        ("a ChunkedEncodingError", requests.exceptions.ChunkedEncodingError("IncompleteRead")),
        ("a ContentDecodingError", requests.exceptions.ContentDecodingError("bad gzip")),
        ("HTTP 502 (non-JSON)", Resp(502, None, "Bad Gateway")),
        ("HTTP 503 -1001", Resp(503, {"code": -1001, "msg": "Internal error"})),
        ("HTTP 400 -1006", Resp(400, {"code": -1006, "msg": "UNEXPECTED_RESP"})),
        ("HTTP 400 -1007", Resp(400, {"code": -1007, "msg": "TIMEOUT"})),
        ("HTTP 400 -1000", Resp(400, {"code": -1000, "msg": "UNKNOWN"})),
        ("HTTP 400 -1001", Resp(400, {"code": -1001, "msg": "DISCONNECTED"})),
        ("HTTP 200 -1007", Resp(200, {"code": -1007, "msg": "TIMEOUT"})),
        ("-1141 duplicated, not found", Resp(400, {"code": -1141, "msg": "Duplicated order"})),
        ("HTTP 200 non-JSON", Resp(200, None, "<html>proxy</html>")),
        ("HTTP 200 without an orderId", Resp(200, {"code": 200, "msg": "ok"})),
        ("HTTP 200 empty body", Resp(200, None, "")),
        ("HTTP 200 JSON list", Resp(200, ["x"])),
        ("HTTP 200 JSON string", Resp(200, "OK")),
        ("HTTP 408 (non-JSON)", Resp(408, None, "<html>Request Timeout</html>")),
        ("HTTP 408 JSON", Resp(408, {"code": -1007, "msg": "timeout"})),
):
    wire(answer, NOT_FOUND)
    try:
        place()
        check(False, f"POST {label}: must not return a fill")
    except sc.OrderNotConfirmed as e:
        check(len(posts()) == 1 and unknown_ok(e) and e.order_id is None,
              f"POST {label}: sent once, parkable unknown outcome with the client id "
              f"({len(posts())} sends, venue_symbol {e.venue_symbol!r})")
    except Exception as e:
        check(False, f"POST {label}: raised {type(e).__name__}: {e} (reads as 拒單)")

# the immediate lookup finds it: confirmed, never resent
wire(requests.exceptions.ReadTimeout("t"), FILLED)
r = place()
lookups = [c for c in CALLS if c["method"] == "GET" and c["query"].get("clientOrderId") == "rc1"]
check(len(posts()) == 1 and lookups and r["order_id"] == "9001" and abs(r["executed_qty"] - 0.0005) < 1e-12,
      "a read timeout, the order found by clientOrderId: confirmed, one POST")
wire(Resp(400, {"code": -1007, "msg": "TIMEOUT"}), FILLED)
check(place()["order_id"] == "9001" and len(posts()) == 1, "-1007, found by clientOrderId: confirmed, one POST")

# no caller id: the lib's own rc… id is what the park carries
wire(requests.exceptions.ReadTimeout("t"), NOT_FOUND)
try:
    sc.place_market_order(ENV, "NVDAUSDT", "long", 0.0005)
    check(False, "no caller id: must raise")
except sc.OrderNotConfirmed as e:
    sent = posts()[0]["body"].get("clientOrderId")
    check(e.parkable() and sent and sent.startswith("rc") and e.client_order_id == sent,
          f"no caller id: the generated clientOrderId is carried, still parkable ({sent})")

# a reduce-only close whose outcome is unknown: parked, and no stop is touched on a guess
wire(requests.exceptions.ReadTimeout("t"), NOT_FOUND)
try:
    sc.place_market_order(ENV, "NVDAUSDT", "long", 0.0005, client_order_id="rc1", reduce_only=True)
    check(False, "close POST unknown: must raise")
except sc.OrderNotConfirmed as e:
    check(unknown_ok(e) and posts()[0]["body"]["side"] == "SELL_CLOSE"
          and not [c for c in CALLS if c["method"] == "DELETE"],
          "a close whose answer is lost: parkable, no STOP cancelled on a guess")

# ── still retried: nothing was sent, or refused before matching ──────────────
wire([requests.exceptions.ConnectTimeout("connect timed out"), ACCEPTED], FILLED)
check(place()["order_id"] == "9001" and len(posts()) == 2, "a connect timeout (nothing sent) is retried")
for label, reason in (("a refused connection", NewConnectionError(None, "Connection refused")),
                      ("a DNS failure", NameResolutionError("api.stockcoin.ai", None, OSError("nodename")))):
    refused = requests.exceptions.ConnectionError(MaxRetryError(None, "/openapi/v1/futures/order", reason=reason))
    wire([refused, ACCEPTED], FILLED)
    check(place()["order_id"] == "9001" and len(posts()) == 2, f"{label} (no socket) is retried")
    wire(refused, FILLED)
    try:
        place()
        check(False, f"{label} every time must raise")
    except sc.OrderNotConfirmed:
        check(False, f"{label} every time: nothing was sent, not an unknown outcome")
    except requests.exceptions.ConnectionError:
        check(len(posts()) == 3, f"{label} every time: raised as is after the retries")
wire([Resp(400, {"code": -1021, "msg": "timestamp"}), ACCEPTED], FILLED)
check(place()["order_id"] == "9001" and len(posts()) == 2, "-1021 (refused at authentication) is re-signed and resent")
wire([Resp(400, {"code": -1003, "msg": "Too many requests"}), ACCEPTED], FILLED)
check(place()["order_id"] == "9001" and len(posts()) == 2, "-1003 (rate limited) is retried")
wire([Resp(429, None, "<html>Too Many Requests</html>"), ACCEPTED], FILLED)
check(place()["order_id"] == "9001" and len(posts()) == 2, "HTTP 429 (non-JSON, rate limited) is retried")
wire([Resp(429, {"code": -1003, "msg": "Too many requests"}), ACCEPTED], FILLED)
check(place()["order_id"] == "9001" and len(posts()) == 2, "HTTP 429 -1003 is retried")
wire([Resp(429, {"code": -1007, "msg": "TIMEOUT"}), ACCEPTED], NOT_FOUND)
try:
    place()
    check(False, "HTTP 429 -1007: must not return a fill")
except sc.OrderNotConfirmed as e:
    looked = [c for c in CALLS if c["method"] == "GET" and c["query"].get("clientOrderId") == "rc1"]
    check(len(posts()) == 1 and looked and unknown_ok(e),
          "HTTP 429 carrying -1007: not retried, looked up by clientOrderId, parkable unknown outcome")
except Exception as e:
    check(False, f"HTTP 429 -1007 raised {type(e).__name__}: {e}")
wire([Resp(429, {"code": -1007, "msg": "TIMEOUT"}), ACCEPTED], FILLED)
check(place()["order_id"] == "9001" and len(posts()) == 1,
      "HTTP 429 carrying -1007, found by clientOrderId: confirmed, one POST")
check("-1141" not in sc.SEND_UNKNOWN_CODES and sc.DUPLICATED_ORDER == "-1141",
      "-1141 is handled on its own (looked up, then unknown), not through SEND_UNKNOWN_CODES")
wire(requests.exceptions.InvalidURL("bad"), FILLED)
try:
    place()
    check(False, "an invalid URL must raise")
except requests.exceptions.InvalidURL:
    check(len(posts()) == 1, "an invalid URL (nothing sent) raises as is")
for code, msg in ((-1131, "Balance insufficient"), (-1149, "create order failed"), (-1157, "not available")):
    wire(Resp(400, {"code": code, "msg": msg}), FILLED)
    try:
        place()
        check(False, f"{code} must raise")
    except sc.OrderNotConfirmed:
        check(False, f"{code} is a plain rejection, not an unknown outcome")
    except sc.StockcoinError as e:
        check(e.code == str(code) and len(posts()) == 1 and not portfolio._outcome_unknown(e),
              f"{code}: StockcoinError, sent once, not an unknown outcome")

# ── the confirm poll ─────────────────────────────────────────────────────────
for label, answer in (("read timeouts", requests.exceptions.ReadTimeout("t")),
                      ("connection errors", requests.exceptions.ConnectionError("reset")),
                      ("HTTP 502", Resp(502, None, "Bad Gateway")),
                      ("-2013 (query side lagging)", NOT_FOUND),
                      ("NEW (not terminal)", ACCEPTED)):
    wire(ACCEPTED, answer)
    try:
        place()
        check(False, f"poll {label}: must not return a fill")
    except sc.OrderNotConfirmed as e:
        check(len(posts()) == 1 and unknown_ok(e, "9001"),
              f"poll {label} for the whole window: parkable OrderNotConfirmed with the order id, one POST")
    except Exception as e:
        check(False, f"poll {label}: raised {type(e).__name__}: {e} (reads as 拒單)")
wire(ACCEPTED, [requests.exceptions.ReadTimeout("t"), NOT_FOUND, FILLED])
r = place()
check(r["order_id"] == "9001" and len(posts()) == 1, "a read timeout, then -2013, then FILLED: the fill, one POST")
wire(ACCEPTED, Resp(200, row(status="CANCELED", executed="2", avg="181")))
r = place()
check(abs(r["executed_qty"] - 0.0002) < 1e-12 and r["avg_price"] == 181.0,
      "canceled after a partial fill: the fill is returned (booked, not resent)")
wire(ACCEPTED, Resp(200, row(status="CANCELED", executed="0", avg="0")))
try:
    place()
    check(False, "canceled with nothing filled must raise")
except sc.OrderNotConfirmed:
    check(False, "canceled with nothing filled is known, not unknown")
except sc.StockcoinError as e:
    check(not portfolio._outcome_unknown(e), "canceled with nothing filled: StockcoinError (a known no-fill)")
# a new contract with no 24h volume skips the turnover check (_check_multiplier), so the first
# order is accepted and its reply shows another multiplier: accepted = never a rejection
# (the next round would send it again), and not parkable (booking it would be wrong-sized)
_stub_rules, _stub_ticker = sc.get_contract_rules, sc._ticker
sc.get_contract_rules = _real_rules
sc._ticker = lambda vsym: {"symbol": vsym, "volume": "0", "quoteVolume": "0", "highPrice": "0",
                           "lowPrice": "0", "lastPrice": "180"}
sc._rules_cache.clear()
wire(ACCEPTED, Resp(200, {**row(), "contractMultiplier": "0.001"}))
try:
    place()
    check(False, "a multiplier mismatch must raise")
except sc.OrderNotConfirmed as e:
    check(portfolio._outcome_unknown(e) and not e.parkable() and str(e.order_id) == "9001"
          and isinstance(e.__cause__, sc.MultiplierMismatch) and "contractMultiplier" in str(e)
          and len(posts()) == 1 and not [c for c in CALLS if c["method"] == "DELETE"],
          "no 24h volume, the reply's multiplier differs: an unknown outcome that cannot be parked "
          "(HALT), one POST, the multiplier named")
except Exception as e:
    check(False, f"a multiplier mismatch raised {type(e).__name__} (reads as 拒單 → resent next round)")
sc.get_contract_rules, sc._ticker = _stub_rules, _stub_ticker
sc._rules_cache.clear()
# the confirm timeout says whether the order was read at all (live_stockcoin_verify stops if not)
wire(ACCEPTED, ACCEPTED)
try:
    place()
    check(False, "poll timeout after reading NEW: must raise")
except sc.OrderNotConfirmed as e:
    check(e.last_status == "NEW", f"poll timeout after reading NEW: last_status NEW ({e.last_status})")
wire(ACCEPTED, requests.exceptions.ReadTimeout("t"))
try:
    place()
    check(False, "poll timeout, never read: must raise")
except sc.OrderNotConfirmed as e:
    check(e.last_status is None, "poll timeout, never read: last_status None")

# ── resolve_unknown_order, through the reconciler's own entry point ──────────
venue_wiring.read_env = lambda *a, **k: ENV


PARKED_AT = 2_000_000.0


def query(order_id=None, cid="rc1", parked_at=PARKED_AT):
    return venue_wiring.query_parked_order({"venue": "stockcoin", "venue_symbol": "NVDAUSDT",
                                            "order_id": order_id, "client_order_id": cid,
                                            "parked_at": parked_at})


wire(ACCEPTED, FILLED)
got = query()
q = [c["query"] for c in CALLS if c["path"].endswith("/futures/order")]
check(got == (0.0005, 180.5) and q and q[0].get("clientOrderId") == "rc1" and "orderId" not in q[0],
      f"parked by client id, filled: looked up by clientOrderId → base qty and price ({got})")
wire(ACCEPTED, FILLED)
got = query(order_id="9001")
q = [c["query"] for c in CALLS if c["path"].endswith("/futures/order")]
check(got == (0.0005, 180.5) and q[0].get("orderId") == "9001", f"parked by order id, filled: by orderId ({got})")
wire(ACCEPTED, Resp(200, row(status="CANCELED", executed="0", avg="0")))
check(query() == (0.0, 0.0), "terminal with nothing filled → (0, 0): released, nothing booked")
wire(ACCEPTED, Resp(200, row(status="REJECTED", executed="0", avg="0")))
check(query() == (0.0, 0.0), "REJECTED → (0, 0)")
wire(ACCEPTED, Resp(200, row(status="CANCELED", executed="2", avg="181")))
check(query() == (0.0002, 181.0), "terminal after a partial fill → the partial")
for label, ans in (("a read timeout", requests.exceptions.ReadTimeout("t")),
                   ("HTTP 502", Resp(502, None, "Bad Gateway")), ("still NEW", ACCEPTED),
                   ("PARTIALLY_FILLED", Resp(200, row(status="PARTIALLY_FILLED", executed="2"))),
                   ("filled without a price", Resp(200, row(avg="0")))):
    wire(ACCEPTED, ans)
    check(query() is None, f"resolve: {label} → still unknown (kept parked)")

# read-only: a filled close read here sends no cancel and reads no position
wire(ACCEPTED, Resp(200, row(side="SELL_CLOSE")))
got = query()
check(got == (0.0005, 180.5) and all(c["method"] == "GET" for c in CALLS)
      and not [c for c in CALLS if "positions" in c["path"] or "orders/open" in c["path"]],
      f"resolving a filled close is read-only: no DELETE, no position or STOP read ({[c['path'] for c in CALLS]})")

# -2013 is never "not sent": history, then fills, else still parked
wire(ACCEPTED, NOT_FOUND)
check(query() is None, "-2013, nothing in history: still unknown (never released on -2013)")
wire(ACCEPTED, NOT_FOUND)
check(query(parked_at=None) is None and not [c for c in CALLS if "history" in c["path"]],
      "-2013 with no park time: still unknown, no unbounded history scan")
wire(ACCEPTED, NOT_FOUND, history=[row(oid="1", cid="other"), row(oid="9002", cid="rc1", executed="3", avg="182")])
got = query()
h = [c["query"] for c in CALLS if "history" in c["path"]]
check(got == (0.0003, 182.0) and h and int(h[0]["startTime"]) == int((PARKED_AT - 300) * 1000)
      and int(h[0]["endTime"]) == int((PARKED_AT + 600) * 1000) and h[0]["symbol"] == "NVDA-PERP-USDT",
      f"-2013, our clientOrderId in the order history around the park: its fill ({got}, {h})")
wire(ACCEPTED, NOT_FOUND, history=[row(cid="rc1", status="CANCELED", executed="0", avg="0")])
check(query() == (0.0, 0.0), "-2013, history shows it CANCELED with nothing filled → (0, 0)")
wire(ACCEPTED, NOT_FOUND, history=[], trades=[
    {"orderId": "9001", "price": "180", "quantity": "2"}, {"orderId": "9001", "price": "183", "quantity": "1"},
    {"orderId": "777", "price": "999", "quantity": "50"}])
got = query(order_id="9001")
check(got is not None and abs(got[0] - 0.0003) < 1e-12 and abs(got[1] - 181.0) < 1e-9,
      f"-2013 with an orderId, not in history: its own fills only, at their VWAP ({got})")
wire(ACCEPTED, NOT_FOUND, history=[], trades=[{"orderId": "777", "price": "999", "quantity": "50"}])
check(query(order_id="9001") is None, "-2013, only another order's fills: still unknown")
wire(ACCEPTED, NOT_FOUND, history=[], trades=[{"orderId": "777", "price": "999", "quantity": "50"}])
check(query() is None and not [c for c in CALLS if "trades" in c["path"]],
      "-2013 with only a client id: fills (which carry no client id) are not matched")

# ── outside this batch: limit / STOP unknowns are not parked as market orders ─
sc.format_price = lambda env, symbol, price, side="BUY": "180"
wire(requests.exceptions.ReadTimeout("t"), NOT_FOUND)
try:
    sc.place_limit_order(ENV, "NVDAUSDT", "long", 0.0005, 180, client_order_id="rc3")
    check(False, "limit POST unknown must raise")
except sc.OrderNotConfirmed:
    check(False, "a limit order is not parked as a market order")
except requests.exceptions.ReadTimeout:
    check(len(posts()) == 1, "limit POST read timeout, not found: sent once, raises as before")
wire(Resp(502, None, "Bad Gateway"), NOT_FOUND)
try:
    sc.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170.0)
    check(False, "STOP POST unknown must raise")
except sc.ProtectionFailed:
    check(len(posts()) == 1, "STOP POST 502, not found: sent once, ProtectionFailed as before")

# half-updated workspace (lib/order_stockcoin.py landed, lib/unconfirmed.py not): the fallback
# base must take the same keywords, or the unknown POST would raise TypeError and read as 拒單
_src = open(os.path.join(ROOT, "lib", "order_stockcoin.py"), encoding="utf-8").read()
_fb = _src[_src.index("except ImportError:  # half-updated workspace: not parkable"):_src.index("class OrderNotConfirmed(")]
_ns = {}
exec("class _OutcomeUnknown(Exception):" + _fb.split("class _OutcomeUnknown(Exception):", 1)[1].replace("\n    ", "\n"), _ns)
_e = _ns["_OutcomeUnknown"]("x", venue="stockcoin", venue_symbol="NVDAUSDT", client_order_id="c")
check(_e.client_order_id == "c" and _e.parkable() is False, "fallback base: same keywords, not parkable")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
