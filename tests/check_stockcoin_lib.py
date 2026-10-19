"""lib/order_stockcoin.py + lib/account_stockcoin.py against the venue doc — no network.

Replies are the venue's OpenAPI doc examples (CONTRACT_OPENAPI.md §2.2 /
§4.2–§4.6 / §6), public-endpoint shapes read 2026-10-15, and /futures/balance
as a live key answered it 2026-10-16; values ours.
requests is replaced for the whole run and any unmocked call fails the test.

Asserts: the signature string is the doc's §2.2 example 2 byte for byte (query
then body, no separator) and what is signed is what is sent; GET puts every
param in the query, POST puts only timestamp there; HTTP 400 / -1002 is
CREDENTIAL, -1003 TRANSIENT, -1021 resyncs and retries once; the four sides;
HALT refuses BUY_OPEN before the transport and lets SELL_CLOSE through; base qty
→ contracts (including float noise at whole contracts), below one contract is
False / ValueError; a reduce is capped at the leg's available contracts; a
cancelled-with-fill market order reports the fill; -1141 resolves to the
existing order instead of raising; a dropped POST is looked up by clientOrderId
and never resent; a multiplier the 24h turnover contradicts, or an order reply
whose contractMultiplier differs, refuses; positions / equity shapes; canonical
symbols both ways and through lib.data.normalize_symbol.

Run: cd blave-agent && .venv/bin/python tests/check_stockcoin_lib.py
"""
import hashlib
import hmac
import json
import os
import re
import sys
import tempfile
from urllib.parse import parse_qsl, urlsplit

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="stockcoin-lib-"))  # guard's state/ lands here
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = os.getcwd()

fails = 0


def check(cond, msg, detail=None):
    global fails
    print(("ok   " if cond else "FAIL ") + msg + ("" if cond or detail is None else f"  {detail}"))
    fails += 0 if cond else 1


class Resp:
    def __init__(self, body, status=200):
        self.status_code = status
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return json.loads(self.text)


CALLS = []
ROUTES = []  # (method, path suffix, responder(params) -> Resp | Exception)


def route(method, suffix, fn):
    ROUTES.insert(0, (method, suffix, fn))


def fake_request(method, url, headers=None, data=None, timeout=None, params=None):
    u = urlsplit(url)
    q = dict(parse_qsl(u.query))
    q.update(params or {})
    body = dict(parse_qsl(data)) if data else {}
    CALLS.append({"method": method.upper(), "path": u.path, "query": q, "body": body,
                  "raw_query": u.query, "raw_body": data, "headers": headers or {}})
    for m, suffix, fn in ROUTES:
        if m == method.upper() and u.path.endswith(suffix):
            out = fn({**q, **body})
            if isinstance(out, Exception):
                raise out
            return out
    raise AssertionError(f"unmocked {method} {u.path}")


requests.request = fake_request
requests.get = lambda url, params=None, headers=None, timeout=None: fake_request("GET", url, headers, None, timeout, params)

from lib import account_stockcoin as acct, guard, order_stockcoin as order  # noqa: E402
from lib.data import normalize_symbol  # noqa: E402

ENV = {"STOCKCOIN_API_KEY": "not-a-real-key", "STOCKCOIN_SECRET_KEY": "not-a-real-secret"}
order.time.sleep = lambda s: None

# public ticker, shape read 2026-10-15 (NVDA: turnover / (contracts × 0.0001) ≈ 224)
TICKER = {"time": 1, "symbol": "NVDA-PERP-USDT", "bestBidPrice": "218.29", "bestAskPrice": "218.33",
          "volume": "111793560", "quoteVolume": "2514677.568976", "lastPrice": "218.29",
          "highPrice": "230.2", "lowPrice": "217.72", "openPrice": "230.03"}
BTC_TICKER = {**TICKER, "symbol": "BTC-PERP-USDT", "volume": "2000000", "quoteVolume": "16200000",
              "lastPrice": "81000", "highPrice": "82000", "lowPrice": "80000"}


def tickers(p):
    return Resp([{"NVDA-PERP-USDT": TICKER, "BTC-PERP-USDT": BTC_TICKER}[p["symbol"]]])


route("GET", "/contract/ticker/24hr", tickers)

# ── signature: doc §2.2 example 2 ────────────────────────────────────────────
qs, bs = order.sign_request("s3cr3t", {"timestamp": 1767930000000},
                            {"symbol": "NVDA-PERP-USDT", "side": "BUY_OPEN", "quantity": "10000",
                             "clientOrderId": "test123"})
want_total = ("timestamp=1767930000000"
              "clientOrderId=test123&quantity=10000&side=BUY_OPEN&symbol=NVDA-PERP-USDT")
want_sig = hmac.new(b"s3cr3t", want_total.encode(), hashlib.sha256).hexdigest()
check(qs == f"timestamp=1767930000000&signature={want_sig}" and
      bs == "clientOrderId=test123&quantity=10000&side=BUY_OPEN&symbol=NVDA-PERP-USDT",
      "signature = HMAC over sorted query + sorted body, no separator (doc §2.2 example 2)")
qs, bs = order.sign_request("s3cr3t", {"symbol": "NVDA-PERP-USDT", "timestamp": 1767930000000})
check(qs.endswith(hmac.new(b"s3cr3t", b"symbol=NVDA-PERP-USDT&timestamp=1767930000000",
                           hashlib.sha256).hexdigest()) and bs == "",
      "GET signs the sorted query alone (doc §2.2 example 1)")

# ── symbols ──────────────────────────────────────────────────────────────────
check(order.venue_symbol("NVDAUSDT") == "NVDA-PERP-USDT" and order.venue_symbol("BTC-PERP-USDT")
      == "BTC-PERP-USDT" and order.canonical_symbol("SKHYNIX-PERP-USDT") == "SKHYNIXUSDT",
      "canonical ↔ venue symbol both ways")
check(normalize_symbol("BTC-PERP-USDT") == "BTCUSDT" and normalize_symbol("BTC-USDT") == "BTCUSDT"
      and normalize_symbol("eth_usdt") == "ETHUSDT", "lib.data.normalize_symbol takes the -PERP- form")
try:
    order.venue_symbol("NVDA")
    check(False, "a symbol without USDT is refused")
except ValueError as e:
    check("symbol_unavailable" in str(e), "a symbol without USDT is refused with the symbol token")

# ── rules / format_qty ───────────────────────────────────────────────────────
r = order.get_contract_rules(ENV, "NVDAUSDT")
check(r == {"step": "1", "min_qty": 0.0001, "min_notional": 0.0, "contract_value": 0.0001},
      "rules: step 1 contract, min one contract in base units", r)
check(order.format_qty(ENV, "NVDAUSDT", 0.0003) == "3" and order.format_qty(ENV, "NVDAUSDT", 0.0060999999999999995) == "61"
      and order.format_qty(ENV, "NVDAUSDT", 0.00039) == "3", "format_qty floors base → contracts, float noise kept whole")
try:
    order.format_qty(ENV, "NVDAUSDT", 0.00009)
    check(False, "below one contract raises ValueError")
except ValueError as e:
    check("below_min_size" in str(e), "below one contract raises ValueError with the below-min token")
order._rules_cache.clear()
acct.MULTIPLIERS["NVDA-PERP-USDT"] = "0.001"
try:
    order.get_contract_rules(ENV, "NVDAUSDT")
    check(False, "a multiplier the 24h turnover contradicts is refused")
except order.StockcoinError as e:
    check("multiplier" in str(e), "a multiplier the 24h turnover contradicts is refused")
del acct.MULTIPLIERS["NVDA-PERP-USDT"]
order._rules_cache.clear()
TICKER_ZERO = {**TICKER, "volume": "0", "quoteVolume": "0"}
route("GET", "/contract/ticker/24hr", lambda p: Resp([TICKER_ZERO]) if p["symbol"] == "NVDA-PERP-USDT" else tickers(p))
check(order.get_contract_rules(ENV, "NVDAUSDT")["contract_value"] == 0.0001,
      "a symbol with no 24h volume keeps the table value (nothing to check against)")
route("GET", "/contract/ticker/24hr", tickers)
order._rules_cache.clear()
check(order.get_mark_price(ENV, "NVDAUSDT") == 218.29, "mark price = ticker lastPrice")
check(order.get_position_mode(ENV) == "hedge", "position mode is hedge")

# ── errors ───────────────────────────────────────────────────────────────────
# a wrong key answers this live; a wrong secret is accepted (the venue checks no signature)
route("GET", "/futures/balance", lambda p: Resp({"code": -1002, "msg": "You are not authorized to execute this request"}, 400))
try:
    acct.get_equity(ENV)
    check(False, "400 / -1002 raises")
except Exception as e:
    check(acct.classify(e) == "credential" and e.http_status == 400,
          "HTTP 400 + -1002 is CREDENTIAL (the 401 fallback never fires here)", acct.classify(e))
route("GET", "/futures/balance", lambda p: Resp({"code": -1005, "msg": "No Permission"}, 400))
try:
    acct.get_equity(ENV)
except Exception as e:
    check(acct.classify(e) == "credential" and "FUTURES-type" in str(e),
          "-1005 is CREDENTIAL and says the key is not a FUTURES key")
route("GET", "/futures/balance", lambda p: Resp({"code": -1003, "msg": "Too many requests"}, 400))
try:
    acct.get_equity(ENV)
except Exception as e:
    check(acct.classify(e) == "transient", "-1003 is TRANSIENT")
check(acct.classify(requests.exceptions.ConnectionError()) == "transient", "a connection error is TRANSIENT")
check(order._REJECT_CODES.get("-1136") == "below_min_size", "-1136 tags below_min_size")
check(set(acct._CREDENTIAL) == {"-1002", "-1005", "-1022"}, "credential codes are the doc's three")

skew = {"n": 0}


def skewed(p):
    skew["n"] += 1
    return Resp({"code": -1021, "msg": "timestamp outside window"}, 400) if skew["n"] == 1 else \
        Resp([{"orderId": "1", "accountId": "777"}])


route("GET", "/openapi/v1/time", lambda p: Resp({"serverTime": 1792033436210}))
route("GET", "/futures/orders/history", skewed)
check(acct.get_account_id(ENV) == "777" and skew["n"] == 2, "-1021 resyncs the clock and retries once")
route("GET", "/futures/orders/history", lambda p: Resp([]))
try:
    acct.get_account_id(ENV)
    check(False, "no order history → get_account_id raises")
except Exception:
    check(True, "no order history → get_account_id raises (never a silent None)")

# ── account shapes (doc §4.1 / §4.2) ─────────────────────────────────────────
POS = [
    {"symbol": "NVDA-PERP-USDT", "side": "LONG", "position": "10000", "available": "10000", "avgPrice": "183.25",
     "leverage": "10", "lastPrice": "188.25", "positionValue": "188.25", "flp": "173.0", "margin": "18.3",
     "unrealizedPnL": "5.0", "realizedPnL": "0", "minMargin": "1"},
    {"symbol": "NVDA-PERP-USDT", "side": "SHORT", "position": "2000", "available": "1500", "avgPrice": "190",
     "leverage": "", "lastPrice": "188.25", "margin": "", "unrealizedPnL": "0.35"},
    {"symbol": "BTC-PERP-USDT", "side": "LONG", "position": "0", "available": "0", "lastPrice": "81000",
     "unrealizedPnL": "99"},
]
route("GET", "/futures/positions", lambda p: Resp([x for x in POS if (not p.get("symbol") or x["symbol"] == p["symbol"])
                                                    and (not p.get("side") or x["side"] == p["side"])]))
# /futures/balance as a live key answered it 2026-10-16 (flat account, 50 USDT moved in);
# the uPnL fields are set non-zero here to exercise the sum
BAL_ROW = {"tokenId": "USDT", "tokenName": "USDT", "futureAssetTotal": "100", "total": "100",
           "availableMargin": "80", "positionMargin": "18.3", "orderMargin": "0",
           "totalUnRealizedPnl": "5.35", "crossUnRealizedPnl": "5.35", "isolatedUnRealizedPnl": "0",
           "crossRealizedPnl": "0", "isolatedRealizedPnl": "0", "availableTransfer": "80", "riskRate": "0"}
route("GET", "/futures/balance", lambda p: Resp([BAL_ROW]))
pos = acct.get_positions(ENV)
check(len(pos) == 2 and pos[0]["symbol"] == "NVDAUSDT" and pos[0]["side"] == "long"
      and abs(pos[0]["size"] - 1.0) < 1e-12 and pos[0]["mark_price"] == 188.25
      and pos[0]["entry_price"] == 183.25 and pos[0]["leverage"] == 10.0,
      "positions: canonical symbol, contracts × 0.0001 = base, lastPrice as mark, details", pos)
check(pos[1]["side"] == "short" and pos[1]["leverage"] is None and pos[1]["margin"] is None,
      "both hedge legs listed; blank details are None, not 0", pos[1])
eq = acct.get_equity(ENV)
check(eq["currency"] == "USDT" and abs(eq["equity"] - 105.35) < 1e-9 and eq["accounts"] == {"futures": 105.35},
      "equity = USDT row total + totalUnRealizedPnl (live list shape)", eq)
route("GET", "/futures/balance", lambda p: Resp([{**BAL_ROW, "tokenId": "BTC", "tokenName": "BTC"}, BAL_ROW]))
check(acct.get_equity(ENV)["equity"] == 105.35, "equity reads the USDT row, not the first row")
route("GET", "/futures/balance", lambda p: Resp([]))
check(acct.get_equity(ENV)["equity"] == 0.0, "an empty futures account answers [] — equity 0, not an error")
route("GET", "/futures/balance", lambda p: Resp([{**BAL_ROW, "total": ""}]))
try:
    acct.get_equity(ENV)
    check(False, "a USDT row without total raises")
except Exception:
    check(True, "a USDT row without total raises (never a made-up 0)")
route("GET", "/futures/balance", lambda p: Resp({"balance": "100"}))
try:
    acct.get_equity(ENV)
    check(False, "a non-list balance reply raises")
except Exception:
    check(True, "a non-list balance reply raises")
route("GET", "/futures/balance", lambda p: Resp([BAL_ROW]))
POS_BAD = [{"symbol": "NVDA-PERP-USDT", "side": "LONG", "position": "5", "lastPrice": "0"}]
route("GET", "/futures/positions", lambda p: Resp(POS_BAD))
try:
    acct.get_positions(ENV)
    check(False, "a non-zero position with no price raises")
except Exception:
    check(True, "a non-zero position with no price raises (never read as flat)")
route("GET", "/futures/positions", lambda p: Resp([x for x in POS if (not p.get("symbol") or x["symbol"] == p["symbol"])
                                                    and (not p.get("side") or x["side"] == p["side"])]))

# ── orders ───────────────────────────────────────────────────────────────────
ORDERS = {}


def order_row(p, status="FILLED", executed=None):
    return {"time": 1, "updateTime": 2, "orderId": p.get("orderId") or "9001", "accountId": "777",
            "clientOrderId": p.get("clientOrderId", ""), "symbol": p.get("symbol"), "price": "0", "leverage": "10",
            "origQty": p.get("quantity", "0"), "executedQty": executed if executed is not None else p.get("quantity", "0"),
            "avgPrice": "188.3", "orderType": "LIMIT", "side": p.get("side"), "timeInForce": "GTC",
            "status": status, "isClose": str(p.get("side", "")).endswith("_CLOSE"), "priceType": "MARKET",
            "contractMultiplier": "0.0001"}


def post_order(p):
    ORDERS["9001"] = order_row(p)
    return Resp(ORDERS["9001"])


route("POST", "/futures/order", post_order)
route("GET", "/futures/order", lambda p: Resp(ORDERS.get(str(p.get("orderId")))
                                              or next((o for o in ORDERS.values() if o["clientOrderId"] == p.get("clientOrderId")),
                                                      {"code": -2013, "msg": "Order does not exist"})))
route("GET", "/futures/trades", lambda p: Resp([{"orderId": "9001", "fee": "0.05"}, {"orderId": "1", "fee": "9"}]))

del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0003, client_order_id="rc261015000000123")
post = next(c for c in CALLS if c["method"] == "POST")
check(post["body"] == {"symbol": "NVDA-PERP-USDT", "side": "BUY_OPEN", "orderType": "LIMIT", "priceType": "MARKET",
                       "price": "0", "quantity": "3", "clientOrderId": "rc261015000000123"}
      and set(post["query"]) == {"timestamp", "signature"} and post["headers"].get("X-BH-APIKEY") == ENV["STOCKCOIN_API_KEY"],
      "POST: business params in the form body, only timestamp + signature in the query", post)
sent_total = post["raw_query"].split("&signature=")[0] + post["raw_body"]
check(post["query"]["signature"] == hmac.new(ENV["STOCKCOIN_SECRET_KEY"].encode(), sent_total.encode(),
                                             hashlib.sha256).hexdigest(), "what is signed is what is sent")
check(res == {"avg_price": 188.3, "executed_qty": 0.0003, "commission": 0.05, "order_id": "9001"},
      "a market order reports the venue's fill in base units, fee off the trade rows", res)
gets = [c for c in CALLS if c["method"] == "GET" and c["path"].endswith("/futures/order")]
check(gets and "orderId" in gets[0]["query"] and "signature" in gets[0]["query"], "GET carries every param in the query")

sides = []
for d, ro in (("long", False), ("short", False), ("long", True), ("short", True)):
    del CALLS[:]
    order.place_market_order(ENV, "NVDAUSDT", d, 0.0001, reduce_only=ro)
    sides.append(next(c for c in CALLS if c["method"] == "POST")["body"]["side"])
check(sides == ["BUY_OPEN", "SELL_OPEN", "SELL_CLOSE", "BUY_CLOSE"], "four sides: open long/short, close long/short", sides)

del CALLS[:]
order.close_position_partial(ENV, "NVDAUSDT", "short", 0.5)
check(next(c for c in CALLS if c["method"] == "POST")["body"]["quantity"] == "1500",
      "a reduce is capped at the leg's available contracts (2000 held, 1500 available)")
check(order.place_market_order(ENV, "NVDAUSDT", "long", 0.00005) is False, "below one contract → False, nothing sent")
check(order.close_position_partial(ENV, "BTCUSDT", "long", 1) is False, "closing a leg with nothing available → False")

# a market order whose rest was cancelled after a partial fill
route("POST", "/futures/order", lambda p: (ORDERS.__setitem__("9001", order_row(p, "CANCELED", "2")), Resp(ORDERS["9001"]))[1])
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0005)
check(abs(res["executed_qty"] - 0.0002) < 1e-12, "cancelled with a partial fill reports the fill, not an error", res)
route("POST", "/futures/order", lambda p: (ORDERS.__setitem__("9001", order_row(p, "REJECTED", "0")), Resp(ORDERS["9001"]))[1])
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.0005)
    check(False, "rejected with nothing filled raises")
except order.StockcoinError:
    check(True, "rejected with nothing filled raises")
route("POST", "/futures/order", lambda p: Resp({"code": -1149, "msg": "Create order failed"}, 400))
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.0005)
except order.StockcoinError as e:
    check(e.code == "-1149" and "-1149" in str(e), "a rejection surfaces the venue's own code")
route("POST", "/futures/order", lambda p: (ORDERS.__setitem__("9001", {**order_row(p), "contractMultiplier": "0.001"}),
                                           Resp(ORDERS["9001"]))[1])
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.0005)
    check(False, "an order reply with another contractMultiplier raises")
except order.StockcoinError as e:
    check("contractMultiplier" in str(e), "an order reply with another contractMultiplier raises")

# -1141: the clientOrderId already exists → that order, not a second one
ORDERS.clear()
ORDERS["9001"] = order_row({"orderId": "9001", "clientOrderId": "dup1", "symbol": "NVDA-PERP-USDT",
                            "side": "BUY_OPEN", "quantity": "3"})
route("POST", "/futures/order", lambda p: Resp({"code": -1141, "msg": "Duplicated order"}, 400))
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0003, client_order_id="dup1")
check(res and res["order_id"] == "9001" and sum(c["method"] == "POST" for c in CALLS) == 1,
      "-1141 resolves to the existing order, one POST", res)

# a POST whose reply died is looked up, never resent
route("POST", "/futures/order", lambda p: requests.exceptions.ConnectionError("reset"))
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0003, client_order_id="dup1")
check(res and res["order_id"] == "9001" and sum(c["method"] == "POST" for c in CALLS) == 1,
      "a dropped POST is found by clientOrderId, never resent")
del CALLS[:]
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.0003, client_order_id="neverplaced")
    check(False, "a dropped POST that cannot be found raises")
except requests.exceptions.ConnectionError:
    check(sum(c["method"] == "POST" for c in CALLS) == 1, "a dropped POST that cannot be found raises, one POST")
try:
    order._cid("bad id!")
    check(False, "a client order id with odd characters is refused")
except ValueError:
    check(True, "a client order id with odd characters is refused")
check(re.search(r"rc\d{12,}", order._cid()) is not None,
      "a generated client order id matches the orphan sweep's rc pattern")

# HALT: entry refused before the transport, close passes
route("POST", "/futures/order", post_order)
guard.trip_halt("test", "user")
del CALLS[:]
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.0003)
    check(False, "HALT refuses BUY_OPEN")
except guard.Halted:
    check(not any(c["method"] == "POST" for c in CALLS), "HALT refuses BUY_OPEN before the transport")
del CALLS[:]
order.close_position_partial(ENV, "NVDAUSDT", "long", 0.0003)
check(any(c["method"] == "POST" and c["body"]["side"] == "SELL_CLOSE" for c in CALLS), "HALT lets SELL_CLOSE through")
os.remove(guard.HALT_PATH)
check(order._order_intent("POST", "/futures/order", {"side": "SELL_CLOSE", "orderType": "STOP"}) == "protective"
      and order._order_intent("POST", "/futures/order", {"side": "BUY_OPEN", "orderType": "STOP"}) == "entry"
      and order._order_intent("DELETE", "/futures/order", {}) == "cancel"
      and order._order_intent("DELETE", "/futures/cancel/batch/symbol", {}) == "cancel",
      "intent: STOP+CLOSE protective, STOP+OPEN entry, DELETE cancel")

# cancel / open orders
route("DELETE", "/futures/order", lambda p: Resp({"code": -2013, "msg": "Order does not exist"}, 400))
check(order.cancel_order(ENV, "NVDAUSDT", order_id="1") == {"status": "order_not_found", "order_id": "1"},
      "cancelling a gone order returns a status, not an exception")
route("DELETE", "/futures/order", lambda p: Resp({**order_row({"orderId": "5", "symbol": "NVDA-PERP-USDT"}), "status": "CANCELED"}))
check(order.cancel_order(ENV, "NVDAUSDT", order_id="5")["status"] == "canceled", "a cancel returns canceled")
route("GET", "/futures/orders/open", lambda p: Resp([{**order_row({"orderId": "7", "clientOrderId": "rc261015000000999",
                                                                   "symbol": "NVDA-PERP-USDT", "side": "SELL_CLOSE"}),
                                                      "orderType": p["orderType"], "status": "NEW", "triggerPrice": "150"}]))
oo, algo = order.get_open_orders(ENV, "NVDAUSDT"), order.get_open_algo_orders(ENV, "NVDAUSDT")
check(oo[0]["symbol"] == "NVDAUSDT" and oo[0]["client_order_id"] == "rc261015000000999" and oo[0]["reduce_only"]
      and algo[0]["stop_order_type"] == "STOP" and algo[0]["trigger_price"] == 150.0,
      "open LIMIT and STOP orders listed with canonical symbols")
check(not any(hasattr(order, n) for n in ("place_limit_order", "open_position", "place_protective_orders",
                                           "place_spot_market_order")),
      "no limit / SL-TP / spot entry points yet — venue_wiring falls back loudly instead of calling a stub")

print("\n" + ("all checks passed" if not fails else f"FAILED: {fails}"))
sys.exit(1 if fails else 0)
