"""Bitget market orders, classic (v2) and UTA (v3): an order whose outcome is unknown is never sent
twice and never reported as a rejection — no network (requests.request is faked, sockets refuse).

What it protects (spec order-unknown-outcome 2026-10-29, Bitget):
- the order POST: a reply that died, a 5xx, a 2xx that is not JSON or 40010 / 40725 / 45001 /
  40015 / a duplicate clientOid was looked up by clientOid ONCE and, when the query side had not
  caught up, raised the transport error itself → recorded as 拒單 → the next round sent a new
  order (a UTA refills a used clientOid, a classic one refuses it — either way a second order);
- the confirm poll after an accepted order: any get_order failure escaped as the error itself,
  and the poll timeout raised an OrderNotConfirmed lib/portfolio could not park.

Asserts, in both account types: the POST goes out exactly once on each of those; an order the
clientOid lookup finds is returned as filled; otherwise OrderNotConfirmed that lib/portfolio
treats as an unknown outcome, parkable, with the CANONICAL symbol (ACNUSDT, not Bitget's
ACNSTOCKUSDT) and the client id; a connect timeout, a refused connection, a DNS failure, a
timestamp refusal and 429 are still retried and a socket that never opened is never parked; a
plain rejection is still BitgetError; a UTA pre-send lookup that fails sends nothing; a poll that
fails throughout ends in OrderNotConfirmed with the order id; cancelled with nothing filled is
still a known no-fill; a limit POST unknown is not parkable; resolve_unknown_order through
venue_wiring.query_parked_order reads a fill / a no-fill by orderId or clientOid, falls back to
the fills around the park when the detail says "no such order" (UTA rows matched on clientOid,
classic rows on orderId only), and keeps everything else unknown.

Run: cd blave-agent && .venv/bin/python tests/check_bitget_order_outcome_unknown.py
"""
import json
import os
import socket
import sys
import tempfile
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlsplit

import requests
from urllib3.exceptions import MaxRetryError, NameResolutionError, NewConnectionError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="bitget-unknown-"))
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = os.getcwd()


def _no_net(*a, **k):
    raise AssertionError("network access in an offline test")


socket.socket.connect = _no_net
socket.create_connection = _no_net

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


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


CALLS = []
ROUTES = {}


def fake_request(method, url, headers=None, data=None, timeout=None, params=None):
    u = urlsplit(url)
    q = dict(parse_qsl(u.query))
    body = json.loads(data) if data else {}
    CALLS.append({"method": method.upper(), "path": u.path, "query": q, "body": body})
    fn = ROUTES.get((method.upper(), u.path))
    if fn is None:
        raise AssertionError(f"unmocked {method} {u.path}")
    out = fn({**q, **body})
    if isinstance(out, BaseException):
        raise out
    return out


requests.request = fake_request
requests.get = requests.post = _no_net

from lib import account_bitget as acct, order_bitget as order, portfolio, venue_wiring  # noqa: E402

ENV = {"BITGET_API_KEY": "bg_not_a_real_key", "BITGET_SECRET_KEY": "not-a-real-secret",
       "BITGET_PASSPHRASE": "not-a-real-pass"}
acct.VERIFIED_MODES = frozenset({"uta", "classic"})
acct.SWITCH_HOLD_S = 0
acct.sync_time = lambda: None
MODE = {"api": "classic"}
acct.account_mode = lambda env, refresh=False: MODE["api"]
acct.uta_settings = lambda env: {"holdMode": "one_way_mode", "symbolConfigList": []}
LEGS = []
acct.leg_rows = lambda env, mode=None: list(LEGS)
clock = {"t": 1_800_000_000.0}
order.time = SimpleNamespace(time=lambda: clock["t"], sleep=lambda s: clock.__setitem__("t", clock["t"] + s),
                             strftime=__import__("time").strftime, gmtime=__import__("time").gmtime)
# a US stock perp whose bare name a coin owns on Bitget: the canonical name differs from the venue's
VSYM = {"ACNUSDT": "ACNSTOCKUSDT"}
order.venue_symbol = lambda symbol: VSYM.get(str(symbol).upper(), str(symbol).upper())
order.get_contract_rules = lambda env, symbol: {"step": "0.01", "min_qty": 0.01, "min_notional": 5.0,
                                                "contract_value": 1.0, "tick": "0.01", "equity": True,
                                                "status": "normal"}
order.get_mark_price = lambda env, symbol: 260.0
ROUTES[("GET", "/api/v2/mix/account/account")] = lambda p: ok({"posMode": "one_way_mode", "marginMode": "crossed"})

PLACE = {"classic": "/api/v2/mix/order/place-order", "uta": "/api/v3/trade/place-order"}
DETAIL = {"classic": "/api/v2/mix/order/detail", "uta": "/api/v3/trade/order-info"}
GONE = {"classic": ("40109", "The data of the order cannot be found, please confirm the order number"),
        "uta": ("25204", "Order does not exist")}


def row(api, state, filled="0.03", avg="260.5", oid="77", cid="rc1"):
    if api == "uta":
        return {"orderId": oid, "clientOid": cid, "category": "USDT-FUTURES", "symbol": "ACNSTOCKUSDT",
                "orderType": "market", "side": "buy", "qty": "0.03", "cumExecQty": filled, "avgPrice": avg,
                "orderStatus": {"canceled": "cancelled"}.get(state, state),
                "feeDetail": [{"feeCoin": "USDT", "fee": "-0.004"}], "cancelReason": ""}
    return {"orderId": oid, "clientOid": cid, "symbol": "ACNSTOCKUSDT", "size": "0.03", "baseVolume": filled,
            "priceAvg": avg, "fee": "-0.004", "state": state, "side": "buy", "cancelReason": ""}


def gone(api):
    return err(*GONE[api])


def wire(api, post, detail_by_cid=None, detail_by_oid=None):
    """post: a list of answers to the place POST, consumed in order (the last repeats); answers are a
    Resp or an exception instance. detail_by_cid / detail_by_oid: the same, for the order detail
    queried by clientOid / by orderId (a UTA queries the clientOid once before every send)."""
    MODE["api"] = api
    del CALLS[:]
    queues = {"post": list(post), "cid": list(detail_by_cid or [gone(api)]),
              "oid": list(detail_by_oid or [ok(row(api, "filled"))])}

    def nxt(name):
        q = queues[name]
        return q.pop(0) if len(q) > 1 else q[0]

    ROUTES[("POST", PLACE[api])] = lambda p: nxt("post")
    ROUTES[("GET", DETAIL[api])] = lambda p: nxt("oid") if p.get("orderId") else nxt("cid")


def posts(api):
    return sum(1 for c in CALLS if c["method"] == "POST" and c["path"] == PLACE[api])


def details(api):
    return [c["query"] for c in CALLS if c["path"] == DETAIL[api]]


def place(**kw):
    return order.place_market_order(ENV, "ACNUSDT", "long", 0.03, client_order_id=kw.pop("cid", "rc1"), **kw)


def unknown_ok(e, order_id=None):
    return (portfolio._outcome_unknown(e) and e.parkable() and e.venue == "bitget"
            and e.venue_symbol == "ACNUSDT" and e.client_order_id == "rc1"
            and (order_id is None and e.order_id is None or str(e.order_id) == str(order_id)))


ACCEPTED = ok({"orderId": "77", "clientOid": "rc1"})
for api in ("classic", "uta"):
    dup = "25212" if api == "uta" else "40786"
    # ── the order POST: may have landed, lookup cannot find it → parked, sent once ──
    for label, answer in (
            ("a read timeout", requests.exceptions.ReadTimeout("read timed out")),
            ("a dropped connection after send", requests.exceptions.ConnectionError("RemoteDisconnected")),
            ("a ChunkedEncodingError", requests.exceptions.ChunkedEncodingError("IncompleteRead")),
            ("an SSL error", requests.exceptions.SSLError("EOF occurred in violation of protocol")),
            ("HTTP 503 (not JSON)", Resp("<html>Service Unavailable</html>", 503)),
            ("HTTP 500 40725", err("40725", "service return an error", 500)),
            ("40010", err("40010", "Request timed out")),
            ("45001", err("45001", "Unknown error")),
            ("40015", err("40015", "System is abnormal, please try again later")),
            (f"duplicate clientOid {dup}", err(dup, "Duplicate clientOid")),
            ("HTTP 200 not JSON", Resp("<html>proxy</html>", 200)),
    ):
        wire(api, [answer, ACCEPTED])
        try:
            place()
            check(False, f"{api} POST {label}: must not return a fill")
        except order.OrderNotConfirmed as e:
            cids = [q.get("clientOid") for q in details(api)]
            check(posts(api) == 1 and unknown_ok(e) and cids == ["rc1"] * (2 if api == "uta" else 1),
                  f"{api} POST {label}: sent once, looked up by clientOid, parkable unknown with the canonical "
                  f"symbol ({posts(api)} sends, {e.venue_symbol!r}, lookups {cids})")
        except Exception as e:
            check(False, f"{api} POST {label}: raised {type(e).__name__}: {e} (reads as 拒單)")

    # the lookup finds what the lost answer would have said: the fill, nothing resent
    found = ok(row(api, "filled"))
    wire(api, [requests.exceptions.ReadTimeout("t")], [gone(api), found] if api == "uta" else [found])
    r = place()
    check(r and r["executed_qty"] == 0.03 and r["order_id"] == "77" and posts(api) == 1,
          f"{api}: a POST whose answer died is found by clientOid and confirmed, never resent ({r})")

    # ── nothing reached Bitget: retried, and never parked ────────────────────
    wire(api, [requests.exceptions.ConnectTimeout("connect timed out"), ACCEPTED])
    r = place()
    check(r and posts(api) == 2, f"{api}: a connect timeout (nothing sent) is retried")
    for label, reason in (("a refused connection", NewConnectionError(None, "Connection refused")),
                          ("a DNS failure", NameResolutionError("api.bitget.com", None, OSError("nodename")))):
        refused = requests.exceptions.ConnectionError(MaxRetryError(None, PLACE[api], reason=reason))
        wire(api, [refused, ACCEPTED])
        r = place()
        check(r and posts(api) == 2, f"{api}: {label} (no socket, nothing sent) is retried")
        wire(api, [refused])
        try:
            place()
            check(False, f"{api}: {label} every time must raise")
        except order.OrderNotConfirmed:
            check(False, f"{api}: {label} every time — nothing was sent, not an unknown outcome")
        except requests.exceptions.ConnectionError as e:
            check(posts(api) == 3 and not portfolio._outcome_unknown(e),
                  f"{api}: {label} every time: raised as is after 3 tries (a plain failure, not parked)")
    wire(api, [requests.exceptions.InvalidURL("bad url")])
    try:
        place()
        check(False, f"{api}: an invalid URL must raise")
    except requests.exceptions.InvalidURL:
        check(posts(api) == 1, f"{api}: an invalid URL (nothing sent) raises as is")
    except Exception as e:
        check(False, f"{api}: an invalid URL raised {type(e).__name__}")
    for label, first in (("timestamp 40008", err("40008", "Request timestamp expired")),
                         ("429", err("429", "Too Many Requests", 429))):
        wire(api, [first, ACCEPTED])
        r = place()
        check(r and posts(api) == 2, f"{api}: {label} (refused before matching) is sent again")
    wire(api, [err("40762", "The order amount exceeds the balance")])
    try:
        place()
        check(False, f"{api}: 40762 must raise")
    except order.OrderNotConfirmed:
        check(False, f"{api}: a plain rejection is not an unknown outcome")
    except acct.BitgetError as e:
        check(e.code == "40762" and posts(api) == 1 and not portfolio._outcome_unknown(e),
              f"{api}: a plain rejection is still BitgetError, sent once, not an unknown outcome")
    if api == "uta":
        wire(api, [ACCEPTED], [err("40010", "Request timed out")])
        try:
            place()
            check(False, "uta: a pre-send clientOid lookup that fails must raise")
        except order.OrderNotConfirmed:
            check(False, "uta: the pre-send lookup failed, nothing was sent: not an unknown outcome")
        except acct.BitgetError:
            check(posts(api) == 0, "uta: a pre-send clientOid lookup that fails (40010) → raised, nothing sent")

    # ── the confirm poll ─────────────────────────────────────────────────────
    for label, answer in (("read timeouts", requests.exceptions.ReadTimeout("t")),
                          ("connection errors", requests.exceptions.ConnectionError("reset")),
                          ("HTTP 502", Resp("<html>Bad Gateway</html>", 502)),
                          ("order does not exist", gone(api)),
                          ("live (not terminal)", ok(row(api, "live", filled="0", avg="")))):
        wire(api, [ACCEPTED], None, [answer])
        try:
            place()
            check(False, f"{api} poll {label}: must not return a fill")
        except order.OrderNotConfirmed as e:
            check(posts(api) == 1 and unknown_ok(e, "77"),
                  f"{api} poll {label} for the whole window: parkable OrderNotConfirmed with the order id, one POST")
        except Exception as e:
            check(False, f"{api} poll {label}: raised {type(e).__name__}: {e} (reads as 拒單)")
    wire(api, [ACCEPTED], None, [requests.exceptions.ReadTimeout("t"), gone(api), ok(row(api, "filled"))])
    r = place()
    check(r and r["executed_qty"] == 0.03 and posts(api) == 1,
          f"{api}: poll read timeout, then not found, then filled: the fill, one POST")
    wire(api, [ok({"clientOid": "rc1"})], [gone(api)] if api == "classic" else [gone(api), gone(api)])
    try:
        place()
        check(False, f"{api}: accepted without an orderId, never readable: must not return a fill")
    except order.OrderNotConfirmed as e:
        check(posts(api) == 1 and unknown_ok(e), f"{api}: accepted without an orderId, never readable: "
                                                 f"parkable by clientOid ({e.order_id!r})")
    wire(api, [ACCEPTED], None, [ok(row(api, "canceled", filled="0.01"))])
    r = place()
    check(r and r["executed_qty"] == 0.01, f"{api}: cancelled after a partial fill → the fill, not an unknown")
    wire(api, [ACCEPTED], None, [ok(row(api, "canceled", filled="0", avg=""))])
    try:
        place()
        check(False, f"{api}: cancelled with nothing filled must raise")
    except order.OrderNotConfirmed:
        check(False, f"{api}: cancelled with nothing filled is known, not unknown")
    except acct.BitgetError as e:
        check(not portfolio._outcome_unknown(e), f"{api}: cancelled with nothing filled: BitgetError (a known no-fill)")

    # ── a one-way close refused whole (over-close), the re-sized resend's answer lost ──
    LEGS[:] = [{"symbol": "ACNSTOCKUSDT", "side": "long", "total": 0.03, "available": 0.03, "mark": 260.0}]
    over = "25231" if api == "uta" else "40804"
    wire(api, [err(over, "Close quantity cannot exceed the held position quantity"),
               requests.exceptions.ReadTimeout("t")])
    try:
        order.close_position_partial(ENV, "ACNUSDT", "long", 0.03, client_order_id="rc1")
        check(False, f"{api}: over-close resend lost must raise")
    except order.OrderNotConfirmed as e:
        sent = [c["body"].get("clientOid") for c in CALLS if c["method"] == "POST"]
        check(len(sent) == 2 and sent[0] == "rc1" and e.client_order_id == sent[1] != "rc1" and e.parkable()
              and e.venue_symbol == "ACNUSDT",
              f"{api}: over-close refused, re-sized resend's answer lost: parked under the id actually sent ({sent})")
    LEGS[:] = []

    # ── limit orders: never resent either, but not parkable ──────────────────
    order.format_price = lambda env, symbol, price, buy=True: "259.00"
    wire(api, [requests.exceptions.ReadTimeout("t")])
    try:
        order.place_limit_order(ENV, "ACNUSDT", "long", 0.03, 259, client_order_id="rc3")
        check(False, f"{api}: limit POST unknown must raise")
    except order.OrderNotConfirmed as e:
        check(posts(api) == 1 and not e.parkable(), f"{api}: limit POST unknown: sent once, not parkable")

# ── resolve_unknown_order, through the reconciler's own entry point ──────────
venue_wiring.read_env = lambda path=".env": ENV
FILLS = {"uta": "/api/v3/trade/fills", "classic": "/api/v2/mix/order/fills"}
PARKED_AT = clock["t"] - 120


def query(api, order_id=None, cid="rc1", parked_at=PARKED_AT):
    MODE["api"] = api
    return venue_wiring.query_parked_order({"venue": "bitget", "venue_symbol": "ACNUSDT", "order_id": order_id,
                                            "client_order_id": cid, "parked_at": parked_at})


def fill(api, qty, px, oid="77", cid="rc1", sym="ACNSTOCKUSDT", fid=None):
    if api == "uta":
        return {"execId": fid or f"e{oid}{cid}{qty}", "orderId": oid, "clientOid": cid, "category": "USDT-FUTURES",
                "symbol": sym, "execPrice": px, "execQty": qty}
    return {"tradeId": fid or f"t{oid}{qty}", "orderId": oid, "symbol": sym.lower(), "price": px, "baseVolume": qty}


def fills_route(api, pages):
    """pages: list of (rows, next-cursor) answered in order; a Resp / exception answered as is."""
    seen = []

    def fn(p):
        seen.append(p)
        x = pages[min(len(seen) - 1, len(pages) - 1)]
        if isinstance(x, (BaseException, Resp)):
            return x
        rows, nxt = x
        return ok({"list": rows, "cursor": nxt} if api == "uta" else {"fillList": rows, "endId": nxt})
    ROUTES[("GET", FILLS[api])] = fn
    return seen


for api in ("classic", "uta"):
    fills_route(api, [([], None)])
    wire(api, [ACCEPTED], [ok(row(api, "filled"))], [ok(row(api, "filled"))])
    got = query(api)
    check(got == (0.03, 260.5) and details(api)[-1].get("clientOid") == "rc1" and "orderId" not in details(api)[-1],
          f"{api}: parked by client id, filled: looked up by clientOid → base qty and price ({got})")
    wire(api, [ACCEPTED], None, [ok(row(api, "filled"))])
    got = query(api, order_id="77")
    check(got == (0.03, 260.5) and details(api)[-1].get("orderId") == "77", f"{api}: parked by order id → by orderId ({got})")
    wire(api, [ACCEPTED], [ok(row(api, "canceled", filled="0", avg=""))])
    check(query(api) == (0.0, 0.0), f"{api}: terminal with nothing filled → (0, 0): released, nothing booked")
    wire(api, [ACCEPTED], [ok(row(api, "canceled", filled="0.01"))])
    check(query(api) == (0.01, 260.5), f"{api}: cancelled after a partial fill → the partial")
    for label, ans in (("a read timeout", requests.exceptions.ReadTimeout("t")),
                       ("HTTP 502", Resp("<html>Bad Gateway</html>", 502)),
                       ("40010", err("40010", "Request timed out")),
                       ("still live", ok(row(api, "live", filled="0", avg=""))),
                       ("partially filled, still working", ok(row(api, "partially_filled", filled="0.01"))),
                       ("filled without a price", ok(row(api, "filled", avg="")))):
        seen = fills_route(api, [([fill(api, "0.03", "260")], None)])
        wire(api, [ACCEPTED], [ans])
        check(query(api) is None and not seen, f"{api}: resolve, {label} → still unknown, fills not read")

    # the detail says "no such order": the fills around the park decide
    seen = fills_route(api, [([], None)])
    wire(api, [ACCEPTED], [gone(api)], [gone(api)])
    check(query(api, order_id="77") is None and len(seen) == 1, f"{api}: not found, no fill in the window → still unknown")
    w = seen[0]
    check(int(w["startTime"]) == int((PARKED_AT - 300) * 1000) and int(w["endTime"]) == int(clock["t"] * 1000)
          and w.get("orderId") == "77" and w.get("limit") == "100",
          f"{api}: fills window = park − 300 s … now (capped at park + 600 s), filtered by orderId ({w})")
    seen = fills_route(api, [([], None)])
    query(api, order_id="77", parked_at=clock["t"] - 7200)
    check(int(seen[0]["endTime"]) == int((clock["t"] - 7200 + 600) * 1000),
          f"{api}: a park 2 h old searches up to park + 600 s, not now ({seen[0]})")
    seen = fills_route(api, [([fill(api, "0.02", "260"), fill(api, "0.01", "263"),
                               fill(api, "5", "1", oid="78", cid="rc9"), fill(api, "1", "1", sym="BTCUSDT")], None)])
    got = query(api, order_id="77")
    check(got is not None and abs(got[0] - 0.03) < 1e-12 and abs(got[1] - 261.0) < 1e-9,
          f"{api}: not found, fills of that orderId → their qty and VWAP; other orders / symbols not counted ({got})")
    seen = fills_route(api, [requests.exceptions.ReadTimeout("t")])
    check(query(api, order_id="77") is None, f"{api}: fills unreadable → still unknown")
    page = [fill(api, "1", "1", oid="78", cid="rc9", fid=f"x{i}") for i in range(100)]
    seen = fills_route(api, [(page, None)])
    check(query(api, order_id="77") is None and len(seen) == 1,
          f"{api}: a full page with no way to the next → still unknown (a partial list could under-book)")
    seen = fills_route(api, [(page, "c1"), ([fill(api, "0.03", "260")], None)])
    got = query(api, order_id="77")
    nxt_key = "cursor" if api == "uta" else "idLessThan"
    check(got == (0.03, 260.0) and len(seen) == 2 and seen[1].get(nxt_key) == "c1",
          f"{api}: the fills are paged ({nxt_key}) until a short page ({got})")

# client id only: UTA fill rows carry clientOid, classic ones do not
seen = fills_route("uta", [([fill("uta", "0.03", "260", oid="91"), fill("uta", "2", "1", oid="92", cid="rc9")], None)])
wire("uta", [ACCEPTED], [gone("uta")])
got = query("uta")
check(got == (0.03, 260.0) and "orderId" not in seen[0],
      f"uta: parked by client id, order-info purged: fills matched on clientOid ({got}, {seen})")
seen = fills_route("classic", [([fill("classic", "0.03", "260")], None)])
wire("classic", [ACCEPTED], [gone("classic")])
check(query("classic") is None and not seen,
      "classic: parked by client id, detail not found: fills carry no clientOid → still unknown, not read")
seen = fills_route("uta", [([fill("uta", "0.03", "260")], None)])
wire("uta", [ACCEPTED], [gone("uta")])
check(query("uta", parked_at=None) is None and not seen, "no park time → no fills window → still unknown")
wire("uta", [ACCEPTED], [ok(None)])
seen = fills_route("uta", [([fill("uta", "0.03", "260")], None)])
check(query("uta") == (0.03, 260.0), "uta: order-info answers success with no order (ORDER_ABSENT) → the fills decide")

# half-updated workspace (lib/order_bitget.py landed, lib/unconfirmed.py not): the fallback base must
# take the same keywords, or the unknown POST would raise TypeError and read as a rejection
_src = open(os.path.join(ROOT, "lib", "order_bitget.py"), encoding="utf-8").read()
_fb = _src[_src.index("except ImportError:  # half-updated workspace: not parkable"):_src.index("class OrderNotConfirmed(")]
_ns = {}
exec("class _OutcomeUnknown(Exception):" + _fb.split("class _OutcomeUnknown(Exception):", 1)[1].replace("\n    ", "\n"), _ns)
_e = _ns["_OutcomeUnknown"]("x", venue="bitget", venue_symbol="ACNUSDT", client_order_id="c")
check(_e.client_order_id == "c" and _e.parkable() is False, "fallback base: same keywords, not parkable")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
