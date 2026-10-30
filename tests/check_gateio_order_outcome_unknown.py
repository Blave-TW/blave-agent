"""Gate.io futures market orders: an order whose outcome is unknown is never sent twice and never
reported as a rejection — no network (requests.request is faked).

What it protects (spec order-unknown-outcome 2026-10-29, Gate.io): `text` ids have no dedup at
all (measured live 2026-08-05), and
- the order POST: a dropped connection, a read timeout, a 5xx or a non-JSON 2xx escaped as an
  error → recorded as 拒單 → the next round sent it again;
- the confirm poll after an accepted order: any get_order failure escaped as the error itself,
  and the poll timeout raised an OrderNotConfirmed lib/portfolio could not park.

Asserts: the POST goes out exactly once on each of those; it raises OrderNotConfirmed that
lib/portfolio treats as an unknown outcome, parkable, with the canonical symbol and the full
`t-` text; the text is read once right away and a found order is confirmed by its id; a connect
timeout, a refused connection and REQUEST_EXPIRED are still retried; a plain rejection is still
GateioError; a poll that fails throughout ends in OrderNotConfirmed with the order id; the
X-Gate-Channel-Id attribution rides every request; resolve_unknown_order through
venue_wiring.query_parked_order reads a fill / a no-fill by id or text, falls back to the
account's fills matched on text / order id (another text's fills not counted), and keeps an
order it cannot find unknown; spot and limit unknowns are not parkable.

Run: cd blave-agent && .venv/bin/python tests/check_gateio_order_outcome_unknown.py
"""
import json, os, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="gateio-unknown-"))

import requests  # noqa: E402
from lib import order_gateio as gt  # noqa: E402
from lib import portfolio, venue_wiring  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


ENV = {"GATEIO_API_KEY": "k", "GATEIO_SECRET_KEY": "s"}
clock = {"t": 1_000_000.0}
gt.time.time = lambda: clock["t"]
gt.time.sleep = lambda s: clock.__setitem__("t", clock["t"] + s)
gt._sync_time = lambda env: None
gt.format_qty = lambda env, symbol, qty, price=None: "100"
gt._rules_cache["fut:BTC_USDT"] = {"multiplier": "0.0001", "min_ct": 1, "tick": "0.1",
                                   "active": True, "equity": False}
TEXT = "t-rc1"


class Resp:
    def __init__(self, status, body=None, text=None):
        self.status_code, self._body = status, body
        self.ok = 200 <= status < 400
        self.text = text if text is not None else ("" if body is None else json.dumps(body))

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


CALLS = {"POST": [], "GET": [], "HEADERS": []}


def wire(posts, gets=None, trades=None):
    """posts / gets: lists of a Resp or an exception instance, consumed in order (last repeats);
    trades: rows my_trades_timerange answers (offset-paged)."""
    for v in CALLS.values():
        v.clear()
    posts, gets, trades = list(posts), list(gets or [Resp(200, {})]), list(trades or [])

    def nxt(q):
        x = q.pop(0) if len(q) > 1 else q[0]
        if isinstance(x, BaseException):
            raise x
        return x

    def request(method, url, headers=None, data=None, timeout=None):
        CALLS["HEADERS"].append(headers or {})
        if method == "POST":
            CALLS["POST"].append(json.loads(data))
            return nxt(posts)
        CALLS["GET"].append(url)
        if "/my_trades_timerange" in url:
            q = dict(kv.split("=") for kv in url.split("?", 1)[1].split("&"))
            off, lim = int(q["offset"]), int(q["limit"])
            return Resp(200, trades[off:off + lim])
        if "/my_trades" in url:
            return Resp(200, [])
        return nxt(gets)

    gt.requests.request = request


def accepted(**kw):
    return Resp(201, {"id": 77, "contract": "BTC_USDT", "size": 100, "left": 100, "status": "open",
                      "text": TEXT, **kw})


def order_row(status, size=100, left=0, fill_price="67000", finish_as="filled"):
    return Resp(200, {"id": 77, "contract": "BTC_USDT", "size": size, "left": left, "status": status,
                      "finish_as": finish_as, "fill_price": fill_price, "text": TEXT})


FILLED = order_row("finished")
NOT_FOUND = Resp(404, {"label": "ORDER_NOT_FOUND", "message": "Order not found"})


def place(cid="rc1"):
    return gt.place_market_order(ENV, "BTCUSDT", "long", 0.01, client_order_id=cid)


def unknown_ok(e, order_id=None):
    return (portfolio._outcome_unknown(e) and e.parkable() and e.venue == "gateio"
            and e.venue_symbol == "BTCUSDT" and e.client_order_id == TEXT
            and (order_id is None or str(e.order_id) == order_id))


def attributed():
    return CALLS["HEADERS"] and all(h.get("X-Gate-Channel-Id") == "blave" for h in CALLS["HEADERS"])


# ── the order POST ───────────────────────────────────────────────────────────
for label, post_answer in (
        ("a read timeout", requests.exceptions.ReadTimeout("read timed out")),
        ("a dropped connection after send", requests.exceptions.ConnectionError("RemoteDisconnected")),
        ("a ChunkedEncodingError", requests.exceptions.ChunkedEncodingError("IncompleteRead")),
        ("HTTP 502 (non-JSON)", Resp(502, None, "Bad Gateway")),
        ("HTTP 500 SERVER_ERROR", Resp(500, {"label": "SERVER_ERROR", "message": "Internal server error"})),
        ("TOO_BUSY under a 4xx", Resp(429, {"label": "TOO_BUSY", "message": "Server is too busy"})),
        ("INTERNAL under a 4xx", Resp(400, {"label": "INTERNAL", "message": "Internal server error"})),
        ("HTTP 201 non-JSON", Resp(201, None, "<html>proxy</html>")),
        ("HTTP 201 empty body", Resp(201, None, "")),
        ("2xx without an id", Resp(201, {"contract": "BTC_USDT", "status": "open"})),
):
    wire([post_answer, accepted()], [NOT_FOUND])
    try:
        place()
        check(False, f"POST {label}: must not return a fill")
    except gt.OrderNotConfirmed as e:
        looked = [g for g in CALLS["GET"] if g.endswith(f"/futures/usdt/orders/{TEXT}")]
        check(len(CALLS["POST"]) == 1 and unknown_ok(e) and e.order_id is None
              and len(looked) == 1 and attributed(),
              f"POST {label}: sent once, text read once, parkable unknown outcome with the text "
              f"({len(CALLS['POST'])} sends, {len(looked)} text reads, venue_symbol {e.venue_symbol!r})")
    except Exception as e:
        check(False, f"POST {label}: raised {type(e).__name__}: {e} (reads as 拒單)")

# the immediate text read finds it: confirmed by its id, one POST
wire([requests.exceptions.ReadTimeout("t")], [FILLED])
r = place()
check(r["status"] == "filled" and abs(r["executed_qty"] - 0.01) < 1e-12 and len(CALLS["POST"]) == 1
      and CALLS["GET"][0].endswith(f"/orders/{TEXT}") and any(g.endswith("/orders/77") for g in CALLS["GET"]),
      f"POST read timeout, the text read finds it: confirmed by id 77, one POST ({CALLS['GET']})")
# a 2xx without an id, the text read finds it: confirmed by its id
wire([Resp(201, {"contract": "BTC_USDT", "status": "open"})], [FILLED])
r = place()
check(r["status"] == "filled" and len(CALLS["POST"]) == 1 and CALLS["GET"][0].endswith(f"/orders/{TEXT}"),
      "2xx without an id, the text read finds it: confirmed by id, one POST")
# the text read errors (read timeout): still unknown, parkable
wire([requests.exceptions.ReadTimeout("t")], [requests.exceptions.ReadTimeout("t")])
try:
    place()
    check(False, "text read failing: must raise")
except gt.OrderNotConfirmed as e:
    check(unknown_ok(e) and len(CALLS["POST"]) == 1, "POST unknown and the text read fails: parkable, one POST")

wire([requests.exceptions.ReadTimeout("t")], [NOT_FOUND])
try:
    gt.place_market_order(ENV, "BTCUSDT", "long", 0.01)
    check(False, "no caller id, POST read timeout: must raise")
except gt.OrderNotConfirmed as e:
    sent = CALLS["POST"][0].get("text")
    check(e.parkable() and sent and sent.startswith("t-") and e.client_order_id == sent,
          f"no caller id: the lib's own text is what the unknown carries ({sent})")

wire([requests.exceptions.ConnectTimeout("connect timed out"), accepted()], [FILLED])
r = place()
check(r["status"] == "filled" and len(CALLS["POST"]) == 2, "a connect timeout (nothing sent) is retried")
wire([Resp(401, {"label": "REQUEST_EXPIRED", "message": "gap"}), accepted()], [FILLED])
r = place()
check(r["status"] == "filled" and len(CALLS["POST"]) == 2, "REQUEST_EXPIRED (refused at authentication) is re-signed and resent")
from urllib3.exceptions import MaxRetryError, NameResolutionError, NewConnectionError  # noqa: E402
for label, reason in (("a refused connection", NewConnectionError(None, "Connection refused")),
                      ("a DNS failure", NameResolutionError("api.gateio.ws", None, OSError("nodename")))):
    refused = requests.exceptions.ConnectionError(MaxRetryError(None, "/api/v4/futures/usdt/orders", reason=reason))
    wire([refused, accepted()], [FILLED])
    r = place()
    check(r["status"] == "filled" and len(CALLS["POST"]) == 2, f"{label} (no socket, nothing sent) is retried")
    wire([refused], [FILLED])
    try:
        place()
        check(False, f"{label} every time must raise")
    except gt.OrderNotConfirmed:
        check(False, f"{label} every time: nothing was sent, not an unknown outcome")
    except requests.exceptions.ConnectionError:
        check(len(CALLS["POST"]) == 3, f"{label} every time: raised as is after the retries (a plain failure)")

wire([requests.exceptions.InvalidURL("bad url")], [FILLED])
try:
    place()
    check(False, "an invalid URL must raise")
except gt.OrderNotConfirmed:
    check(False, "an invalid URL never sent anything: not an unknown outcome")
except requests.exceptions.InvalidURL:
    check(len(CALLS["POST"]) == 1, "an invalid URL (nothing sent) raises as is")
for lbl in ("BALANCE_NOT_ENOUGH", "MARKET_PRICE_TOO_DEVIATED"):
    wire([Resp(400, {"label": lbl, "message": "no"})], [FILLED])
    try:
        place()
        check(False, f"{lbl} must raise")
    except gt.OrderNotConfirmed:
        check(False, f"{lbl}: a plain rejection is not an unknown outcome")
    except gt.GateioError as e:
        check(e.code == lbl and len(CALLS["POST"]) == 1 and not portfolio._outcome_unknown(e),
              f"{lbl}: still GateioError, sent once, not an unknown outcome")

# reads keep their retry: a dropped connection on a GET is retried
wire([accepted()], [requests.exceptions.ConnectionError("reset"), FILLED])
o = gt.get_order(ENV, "BTCUSDT", "77")
check(o["status"] == "filled" and len(CALLS["GET"]) >= 2, "a GET is still retried on a dropped connection")

# ── the confirm poll ─────────────────────────────────────────────────────────
for label, get_answer in (
        ("read timeouts", requests.exceptions.ReadTimeout("read timed out")),
        ("connection errors", requests.exceptions.ConnectionError("reset")),
        ("HTTP 502", Resp(502, None, "Bad Gateway")),
        ("order not found", NOT_FOUND),
        ("open (not terminal)", order_row("open", left=100, finish_as=None)),
):
    wire([accepted()], [get_answer])
    try:
        place()
        check(False, f"poll {label}: must not return a fill")
    except gt.OrderNotConfirmed as e:
        check(len(CALLS["POST"]) == 1 and unknown_ok(e, "77"),
              f"poll {label} for the whole window: parkable OrderNotConfirmed with the order id, one POST")
    except Exception as e:
        check(False, f"poll {label}: raised {type(e).__name__}: {e} (reads as 拒單)")
wire([accepted()], [requests.exceptions.ReadTimeout("t"), NOT_FOUND, FILLED])
r = place()
check(r["status"] == "filled" and abs(r["executed_qty"] - 0.01) < 1e-12 and len(CALLS["POST"]) == 1,
      "a read timeout, then not found, then finished: the fill (base units), one POST")
part = order_row("finished", size=100, left=60, fill_price="67010", finish_as="ioc")
wire([accepted()], [part])
r = place()
check(r["status"] == "filled" and abs(r["executed_qty"] - 0.004) < 1e-12 and r["avg_price"] == 67010.0,
      "ioc after a partial fill: returned with executed_qty (booked, not resent)")
wire([accepted()], [order_row("finished", size=100, left=100, fill_price="0", finish_as="ioc")])
try:
    place()
    check(False, "finished with nothing filled must raise")
except gt.OrderNotConfirmed:
    check(False, "finished with nothing filled is known, not unknown")
except gt.GateioError as e:
    check(not portfolio._outcome_unknown(e), "finished with nothing filled: GateioError (a known no-fill)")
wire([accepted(status="finished", finish_as="ioc", left=100)], [NOT_FOUND])
try:
    place()
    check(False, "POST answer finished with nothing filled must raise")
except gt.GateioError as e:
    check(not portfolio._outcome_unknown(e) and not CALLS["GET"],
          "POST answer already finished, nothing filled: GateioError without polling")

# ── resolve_unknown_order, through the reconciler's own entry point ──────────
venue_wiring.read_env = lambda: ENV
PARKED = clock["t"] - 900


def query(order_id=None, cid=TEXT, parked_at=PARKED):
    return venue_wiring.query_parked_order({"venue": "gateio", "venue_symbol": "BTCUSDT", "order_id": order_id,
                                            "client_order_id": cid, "parked_at": parked_at})


wire([accepted()], [FILLED])
got = query()
check(got == (0.01, 67000.0) and CALLS["GET"][0].endswith(f"/orders/{TEXT}"),
      f"parked by text, still findable: looked up by text → base qty and price ({got})")
wire([accepted()], [FILLED])
got = query(order_id="77")
check(got == (0.01, 67000.0) and CALLS["GET"][0].endswith("/orders/77"), f"parked by order id: by id ({got})")
wire([accepted()], [order_row("finished", left=100, fill_price="0", finish_as="ioc")])
check(query(order_id="77") == (0.0, 0.0), "terminal with nothing filled → (0, 0): released, nothing booked")
wire([accepted()], [part])
check(query(order_id="77") == (0.004, 67010.0), "terminal after a partial fill → the partial")

TRADES = [
    {"trade_id": "1", "order_id": "77", "contract": "BTC_USDT", "size": 60, "price": "67000", "text": TEXT},
    {"trade_id": "2", "order_id": "77", "contract": "BTC_USDT", "size": 40, "price": "67100", "text": TEXT},
    {"trade_id": "3", "order_id": "91", "contract": "BTC_USDT", "size": 500, "price": "66000", "text": "t-other"},
]
wire([accepted()], [NOT_FOUND], trades=TRADES)
got = query()
tq = [g for g in CALLS["GET"] if "/my_trades_timerange" in g]
q = dict(kv.split("=") for kv in tq[0].split("?", 1)[1].split("&")) if tq else {}
check(got is not None and abs(got[0] - 0.01) < 1e-12 and abs(got[1] - 67040.0) < 1e-6,
      f"text no longer findable: the fills matched on text → qty (base) and VWAP, another text's not counted ({got})")
check(q.get("contract") == "BTC_USDT" and int(q.get("from", 0)) == int(PARKED - 300)
      and int(q.get("to", 0)) == int(PARKED + 600),
      f"…searched on the contract from park − 300 s to park + 600 s, in seconds ({q})")
wire([accepted()], [NOT_FOUND], trades=TRADES)
got = query(order_id="91", cid="t-nomatch")
check(got == (0.05, 66000.0), f"order id not findable (zero-fill aged out or not): matched on order_id ({got})")
wire([accepted()], [NOT_FOUND], trades=[t for t in TRADES if t["text"] != TEXT])
check(query() is None, "not found and no fill of ours: still unknown (kept parked, never released as 0)")
many = [{"trade_id": str(i), "order_id": str(1000 + i), "size": 1, "price": "1", "text": "t-x"} for i in range(150)]
many.append({"trade_id": "z", "order_id": "77", "size": 100, "price": "67000", "text": TEXT})
wire([accepted()], [NOT_FOUND], trades=many)
got = query()
check(got == (0.01, 67000.0) and len([g for g in CALLS["GET"] if "/my_trades_timerange" in g]) == 2,
      f"fills past the first page are read (offset paging) ({got})")
gt._TRADES_MAX_PAGES, _keep = 1, gt._TRADES_MAX_PAGES
wire([accepted()], [NOT_FOUND], trades=many)
check(query() is None, "more fills than the pages read: unknown, not a partial answer")
gt._TRADES_MAX_PAGES = _keep
for label, ans in (("a read timeout", requests.exceptions.ReadTimeout("t")),
                   ("HTTP 502", Resp(502, None, "Bad Gateway")),
                   ("still open", order_row("open", left=100, finish_as=None)),
                   ("filled without a price", order_row("finished", fill_price="0"))):
    wire([accepted()], [ans], trades=TRADES)
    check(query() is None, f"resolve: {label} → still unknown (kept parked)")
wire([accepted()], [NOT_FOUND], trades=TRADES)
check(query(parked_at=None) is None, "not found and no park time: unknown (no window to search)")
check(not CALLS["POST"], "resolve sends no order")

# ── outside this batch: spot / limit unknowns are not parked as futures orders ──
gt._rules_cache["spot:BTC_USDT"] = {"amount_step": "0.0001", "price_step": "0.1", "min_base": 0.0001,
                                    "min_quote": 3.0, "active": True}
wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    gt.place_spot_market_order(ENV, "BTCUSDT", "buy", quote_qty=10, client_order_id="rc2")
    check(False, "spot POST unknown must raise")
except gt.OrderNotConfirmed as e:
    check(len(CALLS["POST"]) == 1 and not e.parkable(),
          "spot POST unknown: sent once, not parkable (HALT, never queried as a futures order)")
gt.format_price = lambda env, symbol, price: "67000"
wire([requests.exceptions.ReadTimeout("t")], [FILLED])
try:
    gt.place_limit_order(ENV, "BTCUSDT", "long", 0.01, 67000, client_order_id="rc3")
    check(False, "limit POST unknown must raise")
except gt.OrderNotConfirmed as e:
    check(len(CALLS["POST"]) == 1 and not e.parkable(), "limit POST unknown: sent once, not parkable")

# half-updated workspace (lib/order_gateio.py landed, lib/unconfirmed.py not): the fallback base must
# take the same keywords, or the unknown POST would raise TypeError and read as a rejection
_src = open(os.path.join(ROOT, "lib", "order_gateio.py"), encoding="utf-8").read()
_fb = _src[_src.index("except ImportError:  # half-updated workspace: not parkable"):_src.index("class OrderNotConfirmed(")]
_ns = {}
exec("class _OutcomeUnknown(Exception):" + _fb.split("class _OutcomeUnknown(Exception):", 1)[1].replace("\n    ", "\n"), _ns)
_e = _ns["_OutcomeUnknown"]("x", venue="gateio", venue_symbol="BTCUSDT", client_order_id="c")
check(_e.client_order_id == "c" and _e.parkable() is False, "fallback base: same keywords, not parkable")

print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
