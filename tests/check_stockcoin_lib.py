"""lib/order_stockcoin.py + lib/account_stockcoin.py against the venue doc — no network.

Replies are the venue's OpenAPI doc examples (CONTRACT_OPENAPI.md §2.2 /
§4.2–§4.6 / §6), public-endpoint shapes read 2026-10-15, and /futures/balance
as a live key answered it 2026-10-16; values ours.
requests is replaced for the whole run and any unmocked call fails the test.

Asserts: the signature string is the doc's §2.2 example 2 byte for byte (query
then body, no separator) and what is signed is what is sent; GET puts every
param in the query, POST puts only timestamp there; HTTP 400 / -1002 is
CREDENTIAL, -1003 TRANSIENT, -1021 resyncs and retries once; the four sides;
HALT refuses BUY_OPEN and a bare SELL_CLOSE before the transport, the user's
explicit close (guard.halt_close_pass) lets SELL_CLOSE through; -1157 (contract
not open for API trading) is symbol_unavailable with a Chinese reason naming the
canonical symbol; trade rows that lag the fill are re-read for the fee; base qty
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
from decimal import Decimal
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

# HALT freeze: entry and a bare close refused before the transport; the explicit close passes
route("POST", "/futures/order", post_order)
guard.trip_halt("test", "user")
del CALLS[:]
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.0003)
    check(False, "HALT refuses BUY_OPEN")
except guard.Halted:
    check(not any(c["method"] == "POST" for c in CALLS), "HALT refuses BUY_OPEN before the transport")
del CALLS[:]
try:
    order.close_position_partial(ENV, "NVDAUSDT", "long", 0.0003)
    check(False, "HALT refuses a bare SELL_CLOSE")
except guard.Halted:
    check(not any(c["method"] == "POST" for c in CALLS), "HALT refuses a bare SELL_CLOSE before the transport")
del CALLS[:]
with guard.halt_close_pass("NVDAUSDT", "test"):
    order.close_position_partial(ENV, "NVDAUSDT", "long", 0.0003)
check(any(c["method"] == "POST" and c["body"]["side"] == "SELL_CLOSE" for c in CALLS),
      "HALT lets the user's explicit close (halt_close_pass) through")
guard.clear_halt("test")

# -1157: the contract is listed but not open for API trading (BTC in the live probe)
route("POST", "/futures/order", lambda p: Resp({"code": -1157, "msg": "The trading pair is not available for api trading"}, 400))
del CALLS[:]
try:
    order.place_market_order(ENV, "BTCUSDT", "long", 0.0001)
    check(False, "-1157 raises")
except order.StockcoinError as e:
    msg = str(e)
    check(e.code == "-1157" and msg.startswith("[order_reject:symbol_unavailable] ")
          and "StockCoin 不開放 BTCUSDT 用 API 下單" in msg and "code=-1157" in msg[:200],
          "-1157 is symbol_unavailable, says why in Chinese with the canonical symbol, code inside 200 chars", msg)
    check(sum(c["method"] == "POST" for c in CALLS) == 1, "-1157 is not retried")
route("POST", "/futures/order", post_order)

# trade rows that lag the FILLED status (HYUNDAI close in the live probe) are re-read
reads = []


def lagging_trades(p):
    reads.append(1)
    return Resp([] if len(reads) == 1 else [{"orderId": "9001", "fee": "0.0001"}])


route("GET", "/futures/trades", lagging_trades)
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0001)
check(res["commission"] == 0.0001 and len(reads) == 2, "a fee row missing on the first read is read again", res)
del reads[:]
route("GET", "/futures/trades", lambda p: (reads.append(1), Resp([]))[1])
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0001)
check(res["commission"] is None and len(reads) == 3, "no fee row after the re-reads → None, never 0", res)
route("GET", "/futures/trades", lambda p: Resp([{"orderId": "9001", "fee": "0.05"}, {"orderId": "1", "fee": "9"}]))
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
check(not hasattr(order, "place_spot_market_order"), "no spot entry point (the venue has no spot API)")

# cancel: the reply is the order BEFORE the cancel (live T7) — only a terminal status counts
for raw_status, want in (("NEW", "cancel_accepted"), ("CANCELED", "canceled"), ("FILLED", "order_finished")):
    route("DELETE", "/futures/order", lambda p, st=raw_status: Resp({**order_row({"orderId": "5", "symbol": "NVDA-PERP-USDT"}),
                                                                      "status": st}))
    got = order.cancel_order(ENV, "NVDAUSDT", order_id="5")["status"]
    check(got == want, f"cancel reply {raw_status} → {want}", got)

# ── limit layer (live T7 facts) ──────────────────────────────────────────────
BOOK = {"bids": [["216.87", "1"], ["216.8", "2"], ["216.79", "3"]], "asks": [["216.91", "1"], ["216.95", "2"]]}
route("GET", "/contract/depth", lambda p: Resp(BOOK))
order._price_decimals.clear()
check(order.get_bbo(ENV, "NVDAUSDT") == {"bid": 216.87, "ask": 216.91}, "get_bbo = best bid / ask off the depth")
check(order.format_price(ENV, "NVDAUSDT", 216.8789, "BUY_OPEN") == "216.87"
      and order.format_price(ENV, "NVDAUSDT", 216.8711, "SELL_CLOSE") == "216.88",
      "price at the book's decimals: buys round down, sells up")
LIMITS = []


def post_limit(p):
    LIMITS.append(dict(p))
    if p.get("timeInForce") == "LIMIT_MAKER" and float(p["price"]) >= 216.91 and p["side"].startswith("BUY"):
        return Resp({"code": -1158, "msg": "create limit maker order failed"}, 400)
    if len(p["price"].split(".")[-1]) > DEC_OK[0]:
        return Resp({"code": -1134, "msg": "Order price decimal too long."}, 400)
    return Resp({**order_row(p, status="NEW", executed="0"), "orderId": "8100", "orderType": "LIMIT_MAKER"})


DEC_OK = [2]
route("POST", "/futures/order", post_limit)
res = order.place_limit_order(ENV, "NVDAUSDT", "long", 0.0002, 216.80, client_order_id="rc261020000000001",
                              post_only=True)
check(res.get("order_id") == "8100" and LIMITS[-1]["timeInForce"] == "LIMIT_MAKER" and LIMITS[-1]["orderType"] == "LIMIT"
      and LIMITS[-1]["priceType"] == "INPUT" and LIMITS[-1]["price"] == "216.80" and LIMITS[-1]["quantity"] == "2"
      and LIMITS[-1]["side"] == "BUY_OPEN", "post-only limit = LIMIT + INPUT + timeInForce LIMIT_MAKER, order_id returned",
      LIMITS[-1])
check(order.place_limit_order(ENV, "NVDAUSDT", "long", 0.0001, 216.95, post_only=True) == {"status": "post_only_rejected"},
      "a crossing LIMIT_MAKER (-1158) is post_only_rejected, not an error")
try:
    order.place_limit_order(ENV, "NVDAUSDT", "long", 0.0001, 216.95, time_in_force="LIMIT_MAKER")
    check(False, "-1158 without post_only raises")
except order.StockcoinError as e:
    check(e.code == "-1158", "-1158 without post_only=True raises")
check(order.place_limit_order(ENV, "NVDAUSDT", "long", 0.00009, 216.80) is False, "below one contract → False")
del LIMITS[:]
order.place_limit_order(ENV, "NVDAUSDT", "long", 2.0, 216.95, reduce_only=True)
avail = order._available(ENV, "NVDA-PERP-USDT", "long")
check(LIMITS[-1]["side"] == "SELL_CLOSE" and avail == 10000 and LIMITS[-1]["quantity"] == "10000"
      and LIMITS[-1]["price"] == "216.95",
      "a reduce limit closes the leg, capped at its available contracts", LIMITS[-1])
# -1134: one decimal fewer, once
BOOK["bids"][0] = ["216.875", "1"]
order._price_decimals.clear()
del LIMITS[:]
order.place_limit_order(ENV, "NVDAUSDT", "long", 0.0001, 216.875)
check([x["price"] for x in LIMITS] == ["216.875", "216.87"], "-1134 retries once with one decimal fewer",
      [x["price"] for x in LIMITS])
DEC_OK[0] = 0
del LIMITS[:]
try:
    order.place_limit_order(ENV, "NVDAUSDT", "long", 0.0001, 216.875)
    check(False, "a second -1134 raises")
except order.StockcoinError as e:
    check(e.code == "-1134" and len(LIMITS) == 2, "a second -1134 raises (never a third try)")
BOOK["bids"][0] = ["216.87", "1"]
DEC_OK[0] = 2
order._price_decimals.clear()

# ── STOP stop-loss / take-profit (live T8 facts) ─────────────────────────────
STOPS = {}


def post_stop(p):
    if p.get("orderType") != "STOP":
        return post_order(p) if p.get("priceType") == "MARKET" else post_limit(p)
    oid = str(9500 + len(STOPS))
    STOPS[oid] = dict(p)
    return Resp({"orderId": oid, "clientOrderId": p["clientOrderId"], "symbol": p["symbol"], "orderType": "STOP",
                 "side": p["side"], "status": "ORDER_NEW", "triggerPrice": p["triggerPrice"], "origQty": p["quantity"]})


def open_rows(p):
    if p.get("orderType") == "STOP":
        return Resp([{"orderId": k, "symbol": v["symbol"], "side": v["side"], "orderType": "STOP",
                      "status": "ORDER_NEW", "triggerPrice": v["triggerPrice"]} for k, v in STOPS.items()])
    return Resp([])


DELETED = []


def delete_order(p):
    DELETED.append(dict(p))
    v = STOPS.pop(str(p.get("orderId")), None)
    return Resp({"orderId": p.get("orderId"), "status": "ORDER_CANCELED" if v else "CANCELED"})


route("POST", "/futures/order", post_stop)
route("GET", "/futures/orders/open", open_rows)
route("DELETE", "/futures/order", delete_order)
prot = order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=173.541, tp_price=260.329)
sl, tp = STOPS[prot["sl"]["algoId"]], STOPS[prot["tp"]["algoId"]]
check(sl["side"] == tp["side"] == "SELL_CLOSE" and sl["orderType"] == "STOP" and sl["priceType"] == "MARKET"
      and sl["quantity"] == tp["quantity"] == str(avail) and sl["triggerPrice"] == "173.55" and tp["triggerPrice"] == "260.33",
      "SL and TP = STOP SELL_CLOSE at market, the long leg's available contracts, trigger at the book's decimals",
      (sl, tp))
check(set(prot) == {"sl", "tp"}, "both placed and verified in the open STOP list")
cancelled = order.cancel_protective_orders(ENV, "NVDAUSDT")
check(not STOPS and all(d.get("orderType") == "STOP" for d in DELETED), "cancel_protective_orders cancels with orderType=STOP")
check([c["status"] for c in cancelled] == ["canceled", "canceled"], "a STOP cancel replied ORDER_CANCELED is canceled", cancelled)
route("DELETE", "/futures/order", lambda p: Resp({"orderId": p.get("orderId"), "status": "ORDER_NEW"}))
check(order.cancel_algo_order(ENV, "NVDAUSDT", "1")["status"] == "cancel_accepted",
      "a STOP cancel replied with the pre-cancel ORDER_NEW is cancel_accepted, not canceled")
route("DELETE", "/futures/order", delete_order)
prot = order.place_protective_orders(ENV, "NVDAUSDT", "short", sl_price=200.0)
check(STOPS[prot["sl"]["algoId"]]["side"] == "BUY_CLOSE"
      and STOPS[prot["sl"]["algoId"]]["quantity"] == str(order._available(ENV, "NVDA-PERP-USDT", "short")),
      "a short's stop is BUY_CLOSE for its available contracts")
STOPS.clear()
route("GET", "/futures/orders/open", lambda p: Resp([]))
try:
    order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=173.5)
    check(False, "a STOP missing from the open list raises")
except order.ProtectionFailed as e:
    check("NOT in the open STOP list" in str(e), "a STOP accepted but not listed is ProtectionFailed")
route("GET", "/futures/orders/open", open_rows)
STOPS.clear()
guard.trip_halt("test", "user")
n_before = len(STOPS)
try:
    order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=173.5, tp_price=260.3)
    check(False, "HALT refuses SL/TP")
except order.ProtectionFailed as e:
    check(isinstance(e.__cause__, guard.Halted) and len(STOPS) == n_before and "place_protective_orders" in str(e),
          "HALT: ProtectionFailed caused by Halted, nothing sent")
guard.clear_halt("test")
STOPS.clear()
res = order.open_position(ENV, "NVDAUSDT", "long", 0.0001, sl_price=170.0)
check(res["entry"]["order_id"] and set(res["protection"]) == {"sl"}, "open_position: confirmed entry, then its stop", res)

# ── a close that leaves the leg at zero cancels that leg's STOPs (live T10: the venue keeps them) ──
LEG = {"LONG": 1, "SHORT": 3}
STOPS.clear()
STOPS.update({"s1": {"symbol": "NVDA-PERP-USDT", "side": "SELL_CLOSE", "triggerPrice": "170"},
              "s2": {"symbol": "NVDA-PERP-USDT", "side": "SELL_CLOSE", "triggerPrice": "260"},
              "s3": {"symbol": "NVDA-PERP-USDT", "side": "BUY_CLOSE", "triggerPrice": "250"}})
FILLED = {}


def leg_rows(p):
    return Resp([{"symbol": "NVDA-PERP-USDT", "side": sd, "position": str(n), "available": str(n), "lastPrice": "200"}
                 for sd, n in LEG.items() if n and (not p.get("side") or p["side"] == sd)])


def close_post(p):
    if p.get("orderType") == "STOP":
        return post_stop(p)
    leg = "LONG" if p["side"] in ("BUY_OPEN", "SELL_CLOSE") else "SHORT"
    LEG[leg] += int(p["quantity"]) * (1 if p["side"].endswith("_OPEN") else -1)
    oid = str(9700 + len(FILLED))
    FILLED[oid] = {**order_row(p), "orderId": oid}
    del FILLED[oid]["isClose"]  # live rows carry no isClose: the side says it
    return Resp(FILLED[oid])


ORDER_GETS = []
route("GET", "/futures/positions", leg_rows)
route("POST", "/futures/order", close_post)
route("GET", "/futures/order", lambda p: (ORDER_GETS.append(p.get("orderId")), Resp(FILLED[str(p["orderId"])]))[1])
route("GET", "/futures/orders/open", open_rows)
del DELETED[:]
res = order.close_position_partial(ENV, "NVDAUSDT", "long", 0.0001)
check(LEG["LONG"] == 0 and set(STOPS) == {"s3"} and {d["orderId"] for d in DELETED} == {"s1", "s2"}
      and all(d.get("orderType") == "STOP" for d in DELETED) and len(res["stops_cancel"]) == 2,
      "the long leg closed to zero: its two SELL_CLOSE stops cancelled, the short leg's stop kept", (STOPS, DELETED, res))
del DELETED[:]
res = order.close_position_partial(ENV, "NVDAUSDT", "short", 0.0001)
check(LEG["SHORT"] == 2 and set(STOPS) == {"s3"} and not DELETED and "stops_cancel" not in res,
      "a partial close leaves the stops as they are")
# the position read can lag the fill: a held leg is re-checked on the next poll of the same order
oid = res["order_id"]
LEG["SHORT"] = 0
del DELETED[:]
st = order.get_order(ENV, "NVDAUSDT", oid)
check(set(STOPS) == set() and {d["orderId"] for d in DELETED} == {"s3"} and isinstance(st.get("stops_cancel"), list),
      "a close whose leg read non-zero is checked again on the next poll, and cancels once it reads zero", (STOPS, DELETED))
del DELETED[:]
STOPS["s6"] = {"symbol": "NVDA-PERP-USDT", "side": "BUY_CLOSE", "triggerPrice": "250"}
order.get_order(ENV, "NVDAUSDT", oid)
check(not DELETED and "s6" in STOPS, "once its leg was found flat, a closing order is never checked again")
STOPS.pop("s6")
# an order whose leg stays open is checked at most STOPS_CHECK_TRIES times
LEG["SHORT"] = 5
res = order.close_position_partial(ENV, "NVDAUSDT", "short", 0.0001)
reads = []
_held = order._leg_held
order._leg_held = lambda *a: (reads.append(1), _held(*a))[1]
for _ in range(6):
    order.get_order(ENV, "NVDAUSDT", res["order_id"])
order._leg_held = _held
check(len(reads) == order.STOPS_CHECK_TRIES - 1, "a closing order whose leg stays open stops being re-checked after the cap",
      len(reads))
# a position read that blinks to zero once must not strip a live leg's stops (zero is read twice)
LEG["SHORT"] = 2
STOPS["s7"] = {"symbol": "NVDA-PERP-USDT", "side": "BUY_CLOSE", "triggerPrice": "250"}
seq = [Decimal(0), Decimal(2)]
order._leg_held = lambda *a: seq.pop(0)
check(order._cancel_stops_if_flat(ENV, "NVDAUSDT", "short") == "held" and "s7" in STOPS,
      "zero on the first read but held on the confirming read → nothing cancelled")
order._leg_held = _held
# a failed stop cancel: logged, audited, told to the user (order_errors + notifier), the close stands
SENT = []
from lib import notify as _notify  # noqa: E402
_notify.send_text = lambda m: SENT.append(m)
os.makedirs("manager", exist_ok=True)
route("DELETE", "/futures/order", lambda p: Resp({"code": -1001, "msg": "Internal error"}, 400))
res = order.close_position_partial(ENV, "NVDAUSDT", "short", 0.0002)
audit = open(guard.AUDIT_PATH).read()
rows = json.load(open("manager/order_errors.json"))
check(LEG["SHORT"] == 0 and res["executed_qty"] == 0.0002 and "撤不掉" in res["stops_cancel"]["error"]
      and "stops_cancel_failed" in audit and rows[-1]["symbol"] == "NVDAUSDT" and "撤不掉" in rows[-1]["error"]
      and len(SENT) == 1 and "撤不掉" in SENT[0],
      "a failed stop cancel is logged, audited, recorded as an order error and sent once — the close stands", (res, SENT))
order._cancel_stops_if_flat(ENV, "NVDAUSDT", "short")
check(len(SENT) == 1, "the same failure again inside the cooldown is not sent twice", SENT)
route("DELETE", "/futures/order", delete_order)
# limit (chase) close: the fill is seen through get_order, same cleanup
LEG.update({"LONG": 1, "SHORT": 0})
STOPS.update({"s4": {"symbol": "NVDA-PERP-USDT", "side": "SELL_CLOSE", "triggerPrice": "170"}})
FILLED["9799"] = {**order_row({"orderId": "9799", "symbol": "NVDA-PERP-USDT", "side": "SELL_CLOSE", "quantity": "1"}),
                  "orderType": "LIMIT_MAKER"}
LEG["LONG"] = 0
st = order.get_order(ENV, "NVDAUSDT", "9799")
check(st["status"] == "filled" and "s4" not in STOPS, "a filled limit close (chase) to zero cancels the leg's stops too")
# close_symbol: cancel_all covers STOPs on this venue
STOPS.update({"s5": {"symbol": "NVDA-PERP-USDT", "side": "SELL_CLOSE", "triggerPrice": "170"}})
route("GET", "/futures/orders/open", open_rows)
order.cancel_all_orders(ENV, "NVDAUSDT")
sys.path.insert(0, os.path.join(ROOT, "manager"))
import close_symbol  # noqa: E402
check(not STOPS and "order_stockcoin" in close_symbol._CANCEL_ALL_COVERS_CONDITIONAL,
      "close_symbol: cancel_all_orders clears STOP orders and is listed as covering conditionals")

# ── -1150 CANCEL_ORDER_FAILED: the order may still rest — never "gone" ──
route("DELETE", "/futures/order", lambda p: Resp({"code": -1150, "msg": "cancel order failed"}, 400))
check(order.cancel_order(ENV, "NVDAUSDT", order_id="77")["status"] == "cancel_accepted"
      and order.cancel_algo_order(ENV, "NVDAUSDT", "78")["status"] == "cancel_accepted",
      "-1150 is cancel_accepted on both cancel paths (the caller re-reads), not order_not_found")
# the chase: a cancel answered -1150 is confirmed through the order's status, and while the
# old order still rests nothing is re-posted (two orders on the book = an over-fill)
import threading  # noqa: E402
from lib import execute as _ex  # noqa: E402
_ex._RESIDUAL_USD, _ex._CHASE_POLL_S, _ex._CHASE_TIMEOUT_S = 0.001, 0.0, 5.0
_ex._notify_fn = lambda m: None
_ex._own_only = lambda: False
book = iter([(199.0, 201.0)] + [(198.0, 200.0)] * 50)
placed_n, status_reads = [], []
tools = {"venue": "stockcoin", "bbo": lambda: next(book),
         "place": lambda usd, px, cid, buy, **kw: (placed_n.append(px), {"order_id": "c1"})[1],
         "status": lambda oid: (status_reads.append(oid), {"status": "open", "executed_qty": 0.0, "avg_price": 0.0,
                                                          "orig_qty": 0.0001})[1],
         "cancel": lambda oid: order.cancel_order(ENV, "NVDAUSDT", order_id=oid)}
_ex._chase_thread("NVDAUSDT", 0.02, None, False, "stockcoin", [], tools, threading.Event())
check(len(placed_n) == 1 and len(status_reads) >= 2,
      "chase: -1150 on the cancel → status re-read, the still-resting order is not re-posted", (placed_n, len(status_reads)))
route("DELETE", "/futures/order", delete_order)

# ── -1149: tagged insufficient_margin only when the message names margin / balance ──
for msg, want in (("Insufficient balance", "[order_reject:insufficient_margin]"), ("position limit exceeded", None)):
    route("POST", "/futures/order", lambda p, m=msg: Resp({"code": -1149, "msg": m}, 400))
    try:
        order.place_market_order(ENV, "NVDAUSDT", "long", 0.0001)
        check(False, "-1149 raises")
    except order.StockcoinError as e:
        check(str(e).startswith(want) if want else not str(e).startswith("[order_reject:"),
              f"-1149 '{msg}' → {want or 'untagged'}", str(e))

# ── POST 5xx: the order may have landed — looked up by clientOrderId, never resent ──
POSTS = []


def post_5xx(p):
    POSTS.append(dict(p))
    if p.get("orderType") == "STOP":
        STOPS[p["clientOrderId"]] = {"symbol": p["symbol"], "side": p["side"], "triggerPrice": p["triggerPrice"],
                                      "clientOrderId": p["clientOrderId"]}
    else:
        FILLED[p["clientOrderId"]] = {**order_row(p), "orderId": p["clientOrderId"]}
    return Resp({"code": -1001, "msg": "Internal error"}, 502)


LOOKUPS = []


def get_by_cid(p):
    LOOKUPS.append(dict(p))
    key = p.get("clientOrderId") or str(p.get("orderId"))
    if p.get("orderType") == "STOP":
        v = STOPS.get(key)
        return Resp({**v, "orderId": key, "orderType": "STOP", "status": "ORDER_NEW"} if v else
                    {"code": -2013, "msg": "no"}, 200 if v else 400)
    v = FILLED.get(key)
    return Resp(v if v else {"code": -2013, "msg": "no"}, 200 if v else 400)


route("POST", "/futures/order", post_5xx)
route("GET", "/futures/order", get_by_cid)
LEG.update({"LONG": 0, "SHORT": 0})
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0001)
check(len(POSTS) == 1 and res["order_id"] == POSTS[0]["clientOrderId"],
      "a market POST answered 5xx is found by its clientOrderId and confirmed — one POST, no resend", (POSTS, res))
STOPS.clear()
del POSTS[:], LOOKUPS[:]
LEG["LONG"] = 1
route("GET", "/futures/orders/open", open_rows)
prot = order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170.0)
check(len(POSTS) == 1 and any(q.get("orderType") == "STOP" for q in LOOKUPS) and prot["sl"]["algoId"] == POSTS[0]["clientOrderId"],
      "a STOP POST answered 5xx is looked up in the STOP list (orderType=STOP), not re-placed", (POSTS, LOOKUPS))
STOPS.clear()

# ── every reconcile round: a leg holding nothing gets its stops cancelled (SL fired → orphan TP) ──
route("POST", "/futures/order", close_post)
route("GET", "/futures/order", lambda p: Resp(FILLED[str(p["orderId"])]))
route("DELETE", "/futures/order", delete_order)
LEG.update({"LONG": 0, "SHORT": 4})
STOPS.update({"tp_long": {"symbol": "NVDA-PERP-USDT", "side": "SELL_CLOSE", "triggerPrice": "260"},
              "sl_short": {"symbol": "NVDA-PERP-USDT", "side": "BUY_CLOSE", "triggerPrice": "250"},
              "entry_stop": {"symbol": "NVDA-PERP-USDT", "side": "BUY_OPEN", "triggerPrice": "230"}})
del DELETED[:]
swept = order.sweep_orphan_stops(ENV, acct.get_positions(ENV))
check(swept == [("NVDAUSDT", "long")] and set(STOPS) == {"sl_short", "entry_stop"},
      "sweep: the flat long leg's orphan take-profit cancelled; the held short leg's stop and an entry STOP kept",
      (swept, STOPS))
del DELETED[:]
check(order.sweep_orphan_stops(ENV, acct.get_positions(ENV)) == [] and not DELETED, "sweep with nothing orphaned sends nothing")
# an entry STOP (BUY_OPEN) is never a protective order, even with both legs flat
LEG.update({"LONG": 0, "SHORT": 0})
STOPS.pop("sl_short")
order.sweep_orphan_stops(ENV, [])
check("entry_stop" in STOPS, "sweep never cancels an entry STOP", STOPS)
STOPS.pop("entry_stop")
LEG["SHORT"] = 4
STOPS["sl_short"] = {"symbol": "NVDA-PERP-USDT", "side": "BUY_CLOSE", "triggerPrice": "250"}
# a leg the round read shows held is not re-read at all
reads = []
_held = order._leg_held
order._leg_held = lambda *a: (reads.append(a), _held(*a))[1]
order.sweep_orphan_stops(ENV, acct.get_positions(ENV))
order._leg_held = _held
check(not reads and "sl_short" in STOPS, "sweep: a leg the round shows held costs no extra position read", reads)
# a stale round read (says flat) is re-checked against the venue before cancelling
check(order.sweep_orphan_stops(ENV, []) == [] and "sl_short" in STOPS,
      "a round read that misses a held leg does not cancel its stops — the leg is re-read first")
route("GET", "/futures/orders/open", lambda p: Resp({"code": -1001, "msg": "x"}, 400))
check(order.sweep_orphan_stops(ENV, []) == [], "an unreadable STOP list skips the sweep, never raises")
route("GET", "/futures/orders/open", open_rows)

# venue_wiring runs the sweep inside auto_get_positions, and a sweep failure never breaks the read
from lib import venue_wiring as vw  # noqa: E402
calls = []
_vw_env, _vw_detect = vw.read_env, vw.detect_venue
vw.read_env, vw.detect_venue = (lambda path=".env": ENV), (lambda env: "stockcoin")
_sweep = order.sweep_orphan_stops
order.sweep_orphan_stops = lambda env, pos: calls.append(pos)
out = vw.auto_get_positions()
check(len(calls) == 1 and out.get("NVDAUSDT", {}).get("side") == "short", "auto_get_positions runs the stop sweep each round", out)
order.sweep_orphan_stops = lambda env, pos: 1 / 0
check(vw.auto_get_positions().get("NVDAUSDT", {}).get("side") == "short", "a sweep that raises leaves the position read intact")
order.sweep_orphan_stops, vw.read_env, vw.detect_venue = _sweep, _vw_env, _vw_detect

print("\n" + ("all checks passed" if not fails else f"FAILED: {fails}"))
sys.exit(1 if fails else 0)
