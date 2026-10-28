"""lib/order_bitget.py + lib/account_bitget.py + the Bitget rows of lib/stock_perps — no network.

Replies: the public contract / ticker / time endpoints as read 2026-10-20 (no key), and
private shapes from the v2 docs and the samples ccxt's bitget.py records; values ours.
requests is replaced for the whole run and sockets refuse to connect, so any unmocked
call fails the test instead of reaching Bitget.

Asserts: the signature is Base64(HMAC-SHA256(ts + METHOD + path?query + body)) and what
is signed is what is sent; attribution header absent while the code is empty, present on
every signed and order request once set; error codes → CREDENTIAL / TRANSIENT, a UTA key
(40085) refused with what to do, timestamp codes resync once, the key and passphrase never
appear in a message; contract rules (step / minimum / 5 USDT value / tick / symbolStatus,
and 'equity' from the v3 instrument class, not isRwa); symbols both ways (US *STOCKUSDT, the eight Taiwan tokens, no TW prefix
rule); the four side combinations in one-way and hedge mode; a reduce capped at the leg;
below-minimum → False with nothing sent; a reduce reply without orderId found by
clientOid; a dropped or 5xx POST looked up, never resent; HALT; limit / post-only /
cancel; position TP/SL bodies and verification; the orphan TP/SL sweep; cancel_all
symbol-scoped; equity / positions / holdings / flows; the instrument gate on Bitget.

Run: cd blave-agent && .venv/bin/python tests/check_bitget_lib.py
"""
import base64
import hashlib
import hmac
import json
import os
import socket
import sys
import tempfile
from urllib.parse import parse_qsl, urlsplit

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(tempfile.mkdtemp(prefix="bitget-lib-"))  # guard's state/ lands here
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = os.getcwd()


def _no_net(*a, **k):
    raise AssertionError("network access in an offline test")


socket.socket.connect = _no_net
socket.create_connection = _no_net

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


def ok(data):
    return Resp({"code": "00000", "msg": "success", "requestTime": 1, "data": data})


def err(code, msg, status=400):
    return Resp({"code": code, "msg": msg, "requestTime": 1, "data": None}, status)


CALLS = []
ROUTES = []  # (method, path, responder(params) -> Resp | Exception)


def route(method, path, fn):
    ROUTES.insert(0, (method, path, fn))


def fake_request(method, url, headers=None, data=None, timeout=None, params=None):
    u = urlsplit(url)
    q = dict(parse_qsl(u.query))
    body = json.loads(data) if data else {}
    CALLS.append({"method": method.upper(), "path": u.path, "query": q, "body": body,
                  "raw_query": u.query, "raw_body": data, "headers": dict(headers or {})})
    for m, path, fn in ROUTES:
        if m == method.upper() and u.path == path:
            out = fn({**q, **body})
            if isinstance(out, Exception):
                raise out
            return out
    raise AssertionError(f"unmocked {method} {u.path}")


requests.request = fake_request
requests.get = lambda url, params=None, headers=None, timeout=None: fake_request("GET", url, headers, None, timeout)
requests.post = requests.put = requests.delete = _no_net

from lib import account_bitget as acct, guard, order_bitget as order, reject_token, stock_perps  # noqa: E402
from lib.data import normalize_symbol  # noqa: E402

ENV = {"BITGET_API_KEY": "bg_not_a_real_key", "BITGET_SECRET_KEY": "not-a-real-secret",
       "BITGET_PASSPHRASE": "not-a-real-pass"}
order.time.sleep = lambda s: None
# the lib ships both account types (acct.VERIFIED_MODES, see the gate section below); the
# checks run with no minimum switch hold except in the switch section
BOTH = frozenset({"uta", "classic"})
check(acct.VERIFIED_MODES == BOTH, "the lib ships classic and UTA: venue_traits' bitget row (both real-account verified)")
acct.VERIFIED_MODES = BOTH
acct.SWITCH_HOLD_S = 0

# Binance's class of each symbol (lib/stock_perps reads exchangeInfo; stubbed, no network)
BINANCE = {"BTCUSDT": ("COIN", "BTC"), "NVDAUSDT": ("EQUITY", "NVDA"), "ACNUSDT": ("EQUITY", "ACN"),
           "BBUSDT": ("COIN", "BB"), "ZZZUSDT": ("EQUITY", "ZZZ"), "PAXGUSDT": ("COIN", "PAXG")}
stock_perps.binance_rows = lambda: BINANCE


def contract(sym, base, mult="0.01", min_num=None, place="2", step="1", rwa="YES", status="normal"):
    # field set as the public endpoint answered 2026-10-20
    return {"symbol": sym, "baseCoin": base, "quoteCoin": "USDT", "sizeMultiplier": mult,
            "minTradeNum": min_num or mult, "minTradeUSDT": "5", "pricePlace": place,
            "priceEndStep": step, "volumePlace": "2", "symbolStatus": status, "isRwa": rwa,
            "symbolType": "perpetual", "maxLever": "20"}


CONTRACTS = [contract("BTCUSDT", "BTC", "0.0001", place="1", rwa="NO"),
             contract("NVDAUSDT", "NVDA"), contract("ACNSTOCKUSDT", "ACNSTOCK"),
             contract("BBUSDT", "BB", "1", rwa="NO"), contract("BBSTOCKUSDT", "BBSTOCK"),
             contract("TWTSMUSDT", "TWTSM"), contract("TWUMCUSDT", "TWUMC", "0.1", place="3"),
             contract("TWLOUSDT", "TWLO"), contract("HALFUSDT", "HALF", place="2", step="5", rwa="NO"),
             contract("SHUTUSDT", "SHUT", status="restrictedAPI", rwa="NO"),
             contract("GONEUSDT", "GONE", status="off", rwa="NO"),
             contract("WAITUSDT", "WAIT", status="limit_open", rwa="NO"),
             contract("PAXGUSDT", "PAXG", "0.001"), contract("BHPUSDT", "BHP")]
# v3 (symbolType, instrumentType) as /api/v3/market/instruments answered 2026-10-28; every
# other row: isRwa YES → stock/stock, NO → crypto/crypto
CLASSES = {"PAXGUSDT": ("metal", "metal"), "BHPUSDT": ("crypto", "stock"),
           "TWTSMUSDT": ("stock", "crypto"), "TWUMCUSDT": ("stock", "crypto")}


def contracts(p):
    if "symbol" in p:
        rows = [c for c in CONTRACTS if c["symbol"] == p["symbol"]]
        return ok(rows) if rows else err("40034", f"Parameter {p['symbol']} does not exist")
    return ok(CONTRACTS)


route("GET", "/api/v2/mix/market/contracts", contracts)


def instruments(p):
    if p.get("category") != "USDT-FUTURES":
        return err("40034", "bad category")
    out = []
    for c in CONTRACTS:
        if p.get("symbol") not in (None, c["symbol"]) or c["symbol"] in V3_MISSING:
            continue
        st, it = CLASSES.get(c["symbol"]) or (("stock",) * 2 if c["isRwa"] == "YES" else ("crypto",) * 2)
        out.append({"symbol": c["symbol"], "category": p.get("category"), "baseCoin": c["baseCoin"],
                    "symbolType": st, "instrumentType": it, "isRwa": c["isRwa"], "status": "online"})
    if "symbol" in p and not out:
        return err("25100", f"Trading pair {p['symbol']} does not exist")
    return ok(out)


V3_MISSING = set()  # on v2, not (yet) on v3


route("GET", "/api/v3/market/instruments", instruments)
TICKERS = {"NVDAUSDT": ("182.10", "182.12", "182.11"), "BTCUSDT": ("81000.1", "81000.2", "81000"),
           "TWTSMUSDT": ("73.51", "73.76", "73.63"), "ACNSTOCKUSDT": ("250.1", "250.3", "250.2"),
           "TWUMCUSDT": ("1.401", "1.405", "1.403")}


def ticker(p):
    bid, ask, mark = TICKERS[p["symbol"]]
    return ok([{"symbol": p["symbol"], "lastPr": mark, "bidPr": bid, "askPr": ask, "markPrice": mark}])


route("GET", "/api/v2/mix/market/ticker", ticker)
route("GET", "/api/v2/public/time", lambda p: ok({"serverTime": "1792481187359"}))
# classic account first: what a classic key gets from the v3 settings endpoint is not measured
# (live verify R0) — any non-network refusal sends the probe to the v2 account list
route("GET", "/api/v3/account/settings", lambda p: err("40084", "not a unified account"))
route("GET", "/api/v2/mix/account/accounts", lambda p: ok([]))
acct.MODE_TTL_S = 10 ** 9

# ── signature / attribution ──────────────────────────────────────────────────
want = base64.b64encode(hmac.new(b"s3cr3t", b"1700000000000GET/api/v2/mix/position/all-position?productType=USDT-FUTURES",
                                 hashlib.sha256).digest()).decode()
check(acct.sign("s3cr3t", "1700000000000", "get", "/api/v2/mix/position/all-position?productType=USDT-FUTURES") == want,
      "signature = Base64(HMAC-SHA256(ts + METHOD + path?query + body))")
route("GET", "/api/v2/mix/position/all-position", lambda p: ok([]))
del CALLS[:]
acct.get_positions(ENV)
c = CALLS[-1]
signed = f"{c['headers']['ACCESS-TIMESTAMP']}GET{c['path']}?{c['raw_query']}"
check(c["headers"]["ACCESS-SIGN"] == base64.b64encode(hmac.new(ENV["BITGET_SECRET_KEY"].encode(), signed.encode(),
                                                                hashlib.sha256).digest()).decode()
      and c["query"] == {"productType": "USDT-FUTURES", "marginCoin": "USDT"},
      "a GET signs the query it sends")
check(c["headers"]["ACCESS-PASSPHRASE"] == ENV["BITGET_PASSPHRASE"] and c["headers"]["ACCESS-KEY"] == ENV["BITGET_API_KEY"]
      and acct.BROKER_HEADER not in c["headers"], "headers carry key + passphrase; no channel header while the code is empty")
try:
    acct.get_equity({"BITGET_API_KEY": "k", "BITGET_SECRET_KEY": "s"})
    check(False, "a missing passphrase is refused")
except ValueError as e:
    check("BITGET_PASSPHRASE" in str(e), "a missing passphrase is refused before any request")

# ── symbols ──────────────────────────────────────────────────────────────────
check(order.venue_symbol("NVDAUSDT") == "NVDAUSDT" and order.venue_symbol("btc-usdt") == "BTCUSDT"
      and order.venue_symbol("ACNUSDT") == "ACNSTOCKUSDT" and order.venue_symbol("BBUSDT") == "BBUSDT",
      "canonical → Bitget: plain names, a US stock a coin owns → *STOCKUSDT, the coin keeps its name")
check(acct.canonical("ACNSTOCKUSDT") == "ACNUSDT" and acct.canonical("NVDAUSDT") == "NVDAUSDT"
      and acct.canonical("TWTSMUSDT") == "TWTSMUSDT" and acct.canonical("BBUSDT") == "BBUSDT",
      "Bitget → canonical: *STOCKUSDT reads back as the strategy's name; TW tokens and coins as is")
try:
    order.venue_symbol("ZZZUSDT")
    check(False, "a Binance stock Bitget does not list is refused")
except ValueError as e:
    check("symbol_unavailable" in str(e), "a Binance stock with no Bitget match is refused, never a same-name guess")
check(len(stock_perps.TW_TOKENS) == 8 and stock_perps.tw_token("2330") == "TWTSMUSDT"
      and stock_perps.tw_token("2492") == "WALSINUSDT" and stock_perps.tw_token("1605") is None
      and all(stock_perps.tw_code(v) == k for k, v in stock_perps.TW_TOKENS.items()),
      "TW token table: eight rows, both directions, 2492 華新科 (not 1605)")
check(stock_perps.tw_code("TWLOUSDT") is None and stock_perps.tw_code("TWSTUSDT") is None,
      "no TW prefix rule: TWLO (Twilio) / TWST are not Taiwan stocks")
listed = {c["symbol"] for c in CONTRACTS}
check(all(v.endswith("USDT") for v in stock_perps.TW_TOKENS.values()), "every TW token is a USDT contract name")
check(normalize_symbol("TWTSMUSDT") == "TWTSMUSDT" and normalize_symbol("acnstock_usdt") == "ACNSTOCKUSDT",
      "lib.data.normalize_symbol takes Bitget's names as they are")

# ── rules ────────────────────────────────────────────────────────────────────
r = order.get_contract_rules(ENV, "NVDAUSDT")
check(r == {"step": "0.01", "min_qty": 0.01, "min_notional": 5.0, "contract_value": 1.0, "tick": "0.01",
            "equity": True, "status": "normal"}, "rules: base step, minimum, 5 USDT value, tick, v3 stock class", r)
check(order.get_contract_rules(ENV, "BTCUSDT")["tick"] == "0.1" and order.get_contract_rules(ENV, "HALFUSDT")["tick"] == "0.05"
      and order.get_contract_rules(ENV, "BTCUSDT")["equity"] is False,
      "tick = priceEndStep × 10^-pricePlace; a coin is equity False")
check(order.get_contract_rules(ENV, "PAXGUSDT")["equity"] is False,
      "PAXG: isRwa YES but v3 metal/metal → equity False (not a stock)")
check(order.get_contract_rules(ENV, "BHPUSDT")["equity"] is True
      and order.get_contract_rules(ENV, "TWTSMUSDT")["equity"] is True,
      "v3 fields disagreeing (crypto/stock, stock/crypto) → a stock contract")
V3_MISSING.add("HALFUSDT")
order._rules_cache.clear()
check(order.get_contract_rules(ENV, "HALFUSDT")["equity"] is None and "HALFUSDT" not in order._rules_cache,
      "v3 single read answers 25100: equity None, not cached")
V3_MISSING.clear()
check(order.get_contract_rules(ENV, "HALFUSDT")["equity"] is False and "HALFUSDT" in order._rules_cache,
      "next call reads v3 again: equity False, cached")
_v3 = ROUTES[:]
route("GET", "/api/v3/market/instruments", lambda p: requests.exceptions.ConnectionError("stub: v3 down"))
order._rules_cache.clear()
acct._instruments.update(rows=None, at=0.0)
r = order.get_contract_rules(ENV, "BBUSDT")
check(r["equity"] is None and r["step"] == "1" and "BBUSDT" not in order._rules_cache,
      "v3 unreadable → equity None (never isRwa, not cached), the v2 step still read", r)
try:
    acct.canonical("ACNSTOCKUSDT")
    check(False, "v3 unreadable: a renamed stock position is not read back as its venue name")
except requests.exceptions.ConnectionError:
    check(True, "v3 unreadable: canonical(ACNSTOCKUSDT) raises ConnectionError, never read as flat")
check(acct.canonical("BTCUSDT") == "BTCUSDT" and acct.canonical("PAXGUSDT") == "PAXGUSDT",
      "v3 unreadable: Binance coins (BTC, PAXG) still read back as is")
try:
    stock_perps.canonical("bitget", "ACNSTOCKUSDT", CONTRACTS)
    check(False, "v2 rows handed to stock_perps are refused")
except requests.exceptions.ConnectionError:
    check(True, "v2 rows (no instrumentType) handed to stock_perps → ConnectionError, not every stock read as a coin")
ROUTES[:] = _v3
order._rules_cache.clear()
for sym, why in (("SHUTUSDT", "不開放 API"), ("GONEUSDT", "已下架"), ("NOPEUSDT", "沒有")):
    try:
        order.get_contract_rules(ENV, sym)
        check(False, f"{sym} refused")
    except Exception as e:
        check("symbol_unavailable" in str(e) and why in str(e), f"{sym}: refused as symbol_unavailable ({why})")
check(order.session_open(ENV, "WAITUSDT") is False and order.session_open(ENV, "NVDAUSDT") is True,
      "limit_open holds entries (session_open False)")
check(order.format_qty(ENV, "NVDAUSDT", 0.0399) == "0.03" and order.format_qty(ENV, "NVDAUSDT", 0.009) == ""
      and order.format_qty(ENV, "NVDAUSDT", 0.02, price=182.1) == "", "format_qty floors; below minimum or 5 USDT → ''")
check(order.format_price(ENV, "NVDAUSDT", 182.117, buy=True) == "182.11"
      and order.format_price(ENV, "NVDAUSDT", 182.111, buy=False) == "182.12"
      and order.format_price(ENV, "HALFUSDT", 1.234, buy=True) == "1.20", "prices: buys down, sells up, on the tick")
check(order.get_mark_price(ENV, "TWTSMUSDT") == 73.63 and order.get_bbo(ENV, "TWTSMUSDT") == {"bid": 73.51, "ask": 73.76},
      "mark = markPrice; bbo = bidPr / askPr")

# ── errors ───────────────────────────────────────────────────────────────────
route("GET", "/api/v2/mix/account/accounts", lambda p: err("40006", f"Invalid ACCESS_KEY {ENV['BITGET_API_KEY']}"))
try:
    acct.get_equity(ENV)
    check(False, "40006 raises")
except Exception as e:
    check(acct.classify(e) == "credential" and ENV["BITGET_API_KEY"] not in str(e) and e.http_status == 400,
          "HTTP 400 + 40006 is CREDENTIAL and the key is redacted", str(e))
route("GET", "/api/v2/mix/account/accounts",
      lambda p: err("40085", "You are in Unified Account mode, and the Classic Account API is not supported at this time"))
try:
    acct.get_equity(ENV)
    check(False, "40085 with the UTA settings unreadable raises")
except Exception as e:
    check(acct.classify(e) == "unknown" and "讀取權限" in str(e) and "key_permission" in str(e),
          "40085 while the UTA settings refuse the key → UNKNOWN (no instant HALT), says to enable the UTA read "
          "permission", str(e))
acct.VERIFIED_MODES = frozenset({"classic"})  # as shipped: UTA closed → "not supported yet", not "tick the permission"
try:
    acct.get_equity(ENV)
    check(False, "40085 with the UTA settings unreadable raises (UTA closed)")
except Exception as e:
    check(acct.classify(e) == "unknown" and "還不支援" in str(e) and "讀取權限" not in str(e)
          and "[bitget_account_mode:uta]" in str(e),
          "UTA closed: 40085 while the UTA settings refuse the key → UNKNOWN, says UTA is not supported yet", str(e))
acct.VERIFIED_MODES = BOTH
# a copy-trading key: signature passes, every account read answers 40731. Both probe orders — the
# v3 settings refusing like a trading key's (40084), or answering accountMode "classic"
COPY_MSG = "This product does not support copy trading"
route("GET", "/api/v2/mix/account/accounts", lambda p: err("40731", COPY_MSG))
for label, settings in (("v3 settings 40084", lambda p: err("40084", "not a unified account")),
                        ("v3 settings accountMode classic", lambda p: ok({"uid": "1", "accountMode": "classic",
                                                                          "accountLevel": "basic", "holdMode": "hedge_mode"}))):
    route("GET", "/api/v3/account/settings", settings)
    acct._mode.update(mode=None, at=0.0)
    try:
        acct.get_equity(ENV)
        check(False, f"copy-trading key ({label}) raises")
    except Exception as e:
        check(acct.classify(e) == "credential" and "[bitget_copy_trading_key]" in str(e)
              and str(e).startswith("[order_reject:key_permission]") and "帳戶模式是" not in str(e)
              and "[bitget_account_mode:" not in str(e),
              f"copy-trading key ({label}) → CREDENTIAL, key_permission + [bitget_copy_trading_key], "
              "never the mode-unsupported sentence", str(e))
# v3 settings themselves answering 40731: the reason as is, even when the classic API reads
route("GET", "/api/v3/account/settings", lambda p: err("40731", COPY_MSG))
route("GET", "/api/v2/mix/account/accounts", lambda p: ok([]))
acct._mode.update(mode=None, at=0.0)
try:
    acct.account_mode(ENV)
    check(False, "v3 settings 40731 raises")
except acct.BitgetError as e:
    check(acct.classify(e) == "credential" and "[bitget_copy_trading_key]" in str(e),
          "v3 settings 40731 (classic API reads) → the copy-trading reason, never read as classic", str(e))
# an accountMode outside the documented enum is never traded on, whatever the classic API answers:
# a read that passes, or 40085 (a UTA) — refused with the mode sentence, no guessed API
for am, v2, label in (("classic", lambda p: ok([]), "classic + v2 reads"),
                      ("classic", lambda p: err("40085", "You are in Unified Account mode"), "classic + v2 40085"),
                      ("", lambda p: ok([]), "empty + v2 reads"),
                      ("portfolio", lambda p: ok([]), "a new value + v2 reads")):
    route("GET", "/api/v3/account/settings", lambda p, am=am: ok({"uid": "1", "accountMode": am}))
    route("GET", "/api/v2/mix/account/accounts", v2)
    acct._mode.update(mode=None, at=0.0)
    try:
        got = acct.account_mode(ENV)
        check(False, f"accountMode {label} → refused, not {got!r}")
    except acct.BitgetError as e:
        check(e.code == acct.MODE_UNSUPPORTED and "還沒支援這種模式" in str(e) and acct._mode["mode"] is None,
              f"accountMode {label} → refused with the mode sentence (MODE_UNSUPPORTED), nothing cached", str(e))
route("GET", "/api/v2/mix/account/accounts", lambda p: ok([]))
route("GET", "/api/v3/account/settings", lambda p: err("40084", "not a unified account"))
acct._mode.update(mode="classic", at=acct.time.time())  # back to the classic account for the sections below
route("GET", "/api/v2/mix/account/accounts", lambda p: err("429", "Too Many Requests", 429))
try:
    acct.get_equity(ENV)
except Exception as e:
    check(acct.classify(e) == "transient", "429 is TRANSIENT")
check(acct.classify(requests.exceptions.ConnectionError()) == "transient", "a connection error is TRANSIENT")
skew = {"n": 0}


def skewed(p):
    skew["n"] += 1
    return err("40008", "Request timestamp expired") if skew["n"] == 1 else ok([{"marginCoin": "USDT", "accountEquity": "10"}])


route("GET", "/api/v2/mix/account/accounts", skewed)
route("GET", "/api/v2/account/all-account-balance", lambda p: ok([]))
check(acct.get_equity(ENV)["equity"] == 10.0 and skew["n"] == 2, "40008 resyncs the clock and retries once")

# ── account shapes ───────────────────────────────────────────────────────────
route("GET", "/api/v2/mix/account/accounts", lambda p: ok([
    {"marginCoin": "USDC", "accountEquity": "999"},
    {"marginCoin": "USDT", "available": "40", "accountEquity": "52.5", "usdtEquity": "52.5", "unrealizedPL": "2.5"}]))
route("GET", "/api/v2/account/all-account-balance", lambda p: ok([
    {"accountType": "spot", "usdtBalance": "12.3"}, {"accountType": "futures", "usdtBalance": "60"}, {"accountType": "usdt_futures", "usdtBalance": "60"},
    {"accountType": "funding", "usdtBalance": "0"}, {"accountType": "earn", "usdtBalance": "7"}]))
eq = acct.get_equity(ENV)
check(eq == {"equity": 52.5, "currency": "USDT", "accounts": {"futures": 52.5, "spot": 12.3, "earn": 7.0}},
      "equity = the USDT row's accountEquity; other wallets in the breakdown, futures from the direct read", eq)
route("GET", "/api/v2/account/all-account-balance", lambda p: err("40014", "Incorrect permissions"))
eq = acct.get_equity(ENV)
check(eq["equity"] == 52.5 and eq.get("accounts_partial") is True, "a failed wallet overview keeps equity, marks accounts_partial")
route("GET", "/api/v2/mix/account/accounts", lambda p: ok([]))
check(acct.get_equity(ENV)["equity"] == 0.0, "no USDT futures row = equity 0, not an error")

POS = []
route("GET", "/api/v2/mix/position/all-position", lambda p: ok(POS))
POS[:] = [{"symbol": "ACNSTOCKUSDT", "holdSide": "long", "total": "0.03", "available": "0.03", "markPrice": "250.2",
           "openPriceAvg": "249", "unrealizedPL": "0.036", "marginSize": "0.75", "leverage": "10", "posMode": "one_way_mode"},
          {"symbol": "TWTSMUSDT", "holdSide": "short", "total": "0.07", "available": "0.05", "markPrice": "73.63",
           "openPriceAvg": "", "unrealizedPL": "", "marginSize": "", "leverage": "20"},
          {"symbol": "BTCUSDT", "holdSide": "long", "total": "0", "available": "0", "markPrice": "81000"}]
pos = acct.get_positions(ENV)
check(len(pos) == 2 and pos[0] == {"symbol": "ACNUSDT", "side": "long", "size": 0.03, "mark_price": 250.2,
                                   "entry_price": 249.0, "unrealized_pnl": 0.036, "margin": 0.75, "leverage": 10.0},
      "positions: base size, canonical symbol, display fields", pos)
check(pos[1]["side"] == "short" and pos[1]["entry_price"] is None and pos[1]["margin"] is None,
      "missing display fields are None, never 0")
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.03", "markPrice": "0"}]
try:
    acct.get_positions(ENV)
    check(False, "a position without mark raises")
except Exception:
    check(True, "a non-zero position without markPrice raises (never read as flat)")
POS[:] = []

route("GET", "/api/v2/spot/account/assets", lambda p: ok([
    {"coin": "USDT", "available": "3", "frozen": "0", "locked": "0"}, {"coin": "BTC", "available": "0.001", "frozen": "0"},
    {"coin": "DEAD", "available": "50", "frozen": "0"}, {"coin": "DUST", "available": "0.0001"}]))
route("GET", "/api/v2/account/funding-assets", lambda p: ok([{"coin": "USDC", "available": "8", "frozen": "1"}]))
route("GET", "/api/v2/spot/market/tickers", lambda p: ok([{"symbol": "BTCUSDT", "lastPr": "81000"},
                                                         {"symbol": "DUSTUSDT", "lastPr": "1"}]))
h = acct.get_holdings(ENV)
check([(x["asset"], x["wallet"]) for x in h] == [("BTC", "spot"), ("USDC", "funding"), ("USDT", "spot"), ("DEAD", "spot")]
      and h[-1]["usdt_value"] is None and h[1]["amount"] == 9.0,
      "holdings: spot + funding, priced, a coin with no ticker listed at None, dust dropped", h)

DEP = [{"orderId": "11", "tradeId": "0xaaa", "coin": "USDT", "type": "deposit", "size": "100", "status": "success",
        "dest": "on_chain", "cTime": "1792000000000"},
       {"orderId": "12", "tradeId": "", "coin": "USDT", "size": "5", "status": "success", "dest": "internal_transfer",
        "cTime": "1792000001000"},
       {"orderId": "13", "tradeId": "0xbbb", "coin": "USDT", "size": "7", "status": "pending", "dest": "on_chain",
        "cTime": "1792000002000"}]
WD = [{"orderId": "21", "tradeId": "0xccc", "coin": "ETH", "size": "0.5", "fee": "-0.001", "status": "success",
       "dest": "on_chain", "cTime": "1792000003000"}]
windows = []


def records(rows):
    def fn(p):
        windows.append((int(p["startTime"]), int(p["endTime"])))
        return ok([r for r in rows if int(p["startTime"]) <= int(r["cTime"]) <= int(p["endTime"])])
    return fn


route("GET", "/api/v2/spot/wallet/deposit-records", records(DEP))
route("GET", "/api/v2/spot/wallet/withdrawal-records", records(WD))
acct._now_ms = lambda: 1792481187000
fl = acct.get_flows(ENV, 1792000000)
check(fl == [{"ts": 1792000000, "direction": "in", "currency": "USDT", "amount": 100.0, "txid": "0xaaa"},
             {"ts": 1792000003, "direction": "out", "currency": "ETH", "amount": 0.5, "txid": "0xccc"}],
      "flows: on-chain + success only (internal_transfer and pending dropped)", fl)
del windows[:]
acct.get_flows(ENV, 1792481187 - 200 * 86400)
check(len(windows) == 6 and all(e - s <= acct.FLOW_WINDOW_MS for s, e in windows),
      "a 200-day pull is split into ≤89-day windows per endpoint", windows)
route("GET", "/api/v2/spot/account/info", lambda p: ok({"userId": "4242", "authorities": ["coor", "rcor"]}))
check(acct.get_account_id(ENV) == "4242", "get_account_id = the key's userId (classic)")

# ── orders ───────────────────────────────────────────────────────────────────
MODE = {"posMode": "one_way_mode", "marginMode": "crossed"}
route("GET", "/api/v2/mix/account/account", lambda p: ok({"marginCoin": "USDT", **MODE}))
ORDERS = {}
POSTS = []


def place(p):
    POSTS.append(p)
    oid = str(9000 + len(POSTS))
    ORDERS[oid] = {"orderId": oid, "clientOid": p["clientOid"], "symbol": p["symbol"], "size": p["size"],
                   "baseVolume": p["size"], "priceAvg": "182.11", "fee": "-0.0033", "state": "filled",
                   "reduceOnly": p.get("reduceOnly", "NO"), "tradeSide": p.get("tradeSide", "")}
    return ok({"orderId": oid, "clientOid": p["clientOid"]})


def detail(p):
    o = ORDERS.get(p.get("orderId")) or next((x for x in ORDERS.values() if x["clientOid"] == p.get("clientOid")), None)
    return ok(o) if o else err("40109", "The data of the order cannot be found")


route("POST", "/api/v2/mix/order/place-order", place)
route("GET", "/api/v2/mix/order/detail", detail)
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0399, client_order_id="rc261020000000001")
b = POSTS[-1]
check(b == {"symbol": "NVDAUSDT", "productType": "USDT-FUTURES", "marginMode": "crossed", "marginCoin": "USDT",
            "size": "0.03", "orderType": "market", "clientOid": "rc261020000000001", "side": "buy"},
      "one-way entry long: side buy, no tradeSide / reduceOnly, size base on the step, margin mode read", b)
check(res == {"avg_price": 182.11, "executed_qty": 0.03, "commission": 0.0033, "order_id": "9001"},
      "result is the venue's fill (fee as a positive cost)", res)
post = next(c for c in CALLS if c["method"] == "POST")
signed = f"{post['headers']['ACCESS-TIMESTAMP']}POST{post['path']}{post['raw_body']}"
check(post["headers"]["ACCESS-SIGN"] == base64.b64encode(hmac.new(ENV["BITGET_SECRET_KEY"].encode(), signed.encode(),
                                                                   hashlib.sha256).digest()).decode()
      and post["raw_body"] == json.dumps(b, separators=(",", ":")), "a POST signs the exact compact JSON it sends")
order.place_market_order(ENV, "NVDAUSDT", "short", 0.03)
check(POSTS[-1]["side"] == "sell" and "reduceOnly" not in POSTS[-1], "one-way entry short: side sell")
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.05", "available": "0.04", "markPrice": "182"}]
order.close_position_partial(ENV, "NVDAUSDT", "long", 0.09)
check(POSTS[-1]["side"] == "sell" and POSTS[-1].get("reduceOnly") == "YES" and POSTS[-1]["size"] == "0.04"
      and "tradeSide" not in POSTS[-1], "one-way close long: sell + reduceOnly YES, capped at the leg's available")
MODE["posMode"] = "hedge_mode"
order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
check(POSTS[-1]["side"] == "buy" and POSTS[-1]["tradeSide"] == "open" and "reduceOnly" not in POSTS[-1],
      "hedge open long: side buy + tradeSide open")
order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03)
check(POSTS[-1]["side"] == "buy" and POSTS[-1]["tradeSide"] == "close", "hedge close long: side buy + tradeSide close (the leg, not the action)")
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "short", "total": "0.05", "available": "0.05", "markPrice": "182"}]
order.close_position_partial(ENV, "NVDAUSDT", "short", 0.03)
check(POSTS[-1]["side"] == "sell" and POSTS[-1]["tradeSide"] == "close", "hedge close short: side sell + tradeSide close")
n = len(POSTS)
check(order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03) is False and len(POSTS) == n,
      "closing a leg that holds nothing → False, nothing sent")
POS[:] = []
check(order.place_market_order(ENV, "NVDAUSDT", "long", 0.009) is False and order.place_market_order(ENV, "NVDAUSDT", "long", 0.02) is False
      and len(POSTS) == n, "below the minimum size or the 5 USDT value → False, nothing sent")
check(order.get_position_mode(ENV) == "hedge", "position mode hedge_mode → 'hedge'")
MODE["posMode"] = "one_way_mode"
check(order.get_position_mode(ENV) == "oneway", "position mode one_way_mode → 'oneway' (venue_wiring nets)")

route("POST", "/api/v2/mix/order/place-order", lambda p: err("45110", "less than the minimum amount 5 USDT"))
check(order.place_market_order(ENV, "NVDAUSDT", "long", 0.03) is False, "45110 below the 5 USDT minimum → False")
route("POST", "/api/v2/mix/order/place-order", lambda p: err("40762", "The order amount exceeds the balance"))
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "40762 raises")
except Exception as e:
    check(str(e).startswith("[order_reject:insufficient_margin]"), "40762 tags insufficient_margin", str(e))
COPY_MSG = "This product does not support copy trading"
n_place = sum(1 for c in CALLS if c["path"] == "/api/v2/mix/order/place-order")
route("POST", "/api/v2/mix/order/place-order", lambda p: err("40731", COPY_MSG))
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "40731 on an order raises")
except Exception as e:
    check(str(e).startswith("[order_reject:key_permission]") and "[bitget_copy_trading_key]" in str(e)
          and sum(1 for c in CALLS if c["path"] == "/api/v2/mix/order/place-order") == n_place + 1,
          "40731 on an order: key_permission + the copy-trading marker, sent once (not retried)", str(e))
    check(acct.COPY_KEY_TAG in str(e)[:200] and acct.COPY_KEY_TAG in reject_token.to_front("close_symbol: " + str(e))[:200],
          "40731: the [bitget_copy_trading_key] marker survives order_errors' 200-char cut", str(e))
route("POST", "/api/v2/mix/order/place-order", place)


def place_no_id(p):
    place(p)
    return ok({"orderId": None, "clientOid": p["clientOid"]})


route("POST", "/api/v2/mix/order/place-order", place_no_id)
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.05", "available": "0.05", "markPrice": "182"}]
res = order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03, client_order_id="rcnoid1")
check(res and res["executed_qty"] == 0.03 and CALLS[-1]["query"].get("clientOid") == "rcnoid1",
      "a reduce reply without orderId is confirmed by clientOid", res)
POS[:] = []


def drop(p):
    place(p)
    return requests.exceptions.ConnectionError("reset")


route("POST", "/api/v2/mix/order/place-order", drop)
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
check(res and sum(c["method"] == "POST" for c in CALLS) == 1, "a POST whose reply died is found by clientOid, never resent")


def server_error(p):
    place(p)
    return err("40725", "service error", 500)


route("POST", "/api/v2/mix/order/place-order", server_error)
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
check(res and sum(c["method"] == "POST" for c in CALLS) == 1, "a 5xx / 40725 POST is looked up, never resent")
route("POST", "/api/v2/mix/order/place-order", lambda p: requests.exceptions.ConnectionError("reset"))
del CALLS[:]
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "an unfindable dropped POST raises")
except requests.exceptions.ConnectionError:
    check(sum(c["method"] == "POST" for c in CALLS) == 1, "a dropped POST that cannot be found raises, one POST")


def cancelled_partial(p):
    place(p)
    ORDERS[str(9000 + len(POSTS))].update(state="canceled", baseVolume="0.01")
    return ok({"orderId": str(9000 + len(POSTS))})


route("POST", "/api/v2/mix/order/place-order", cancelled_partial)
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
check(res["executed_qty"] == 0.01, "a market order cancelled after a partial fill reports the fill")


def cancelled_empty(p):
    place(p)
    ORDERS[str(9000 + len(POSTS))].update(state="canceled", baseVolume="0", cancelReason="market_order_no_liquidity")
    return ok({"orderId": str(9000 + len(POSTS))})


route("POST", "/api/v2/mix/order/place-order", cancelled_empty)
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "a market order cancelled with nothing filled raises")
except Exception as e:
    check("no_liquidity" in str(e), "a market order cancelled with nothing filled raises with the venue's reason")
route("POST", "/api/v2/mix/order/place-order", place)
try:
    order._cid("x" * 33)
    check(False, "a 33-character client id is refused")
except ValueError:
    check(len(order._cid()) <= 32 and order._cid().startswith("rc"), "client ids: generated ones fit 32 chars, longer refused")

# HALT freeze: entry and a bare close refused before the transport; the explicit close passes
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.05", "available": "0.05", "markPrice": "182"}]
guard.trip_halt("test", "user")
for label, fn in (("entry", lambda: order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)),
                  ("bare close", lambda: order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03))):
    del CALLS[:]
    try:
        fn()
        check(False, f"HALT refuses the {label}")
    except guard.Halted:
        check(not any(c["method"] == "POST" for c in CALLS), f"HALT refuses the {label} before the transport")
del CALLS[:]
with guard.halt_close_pass("NVDAUSDT", "test"):
    order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03)
check(any(c["method"] == "POST" and c["body"].get("reduceOnly") == "YES" for c in CALLS),
      "HALT lets the user's explicit close (halt_close_pass) through")
guard.clear_halt("test")
POS[:] = []
check(order._order_intent("POST", order.ORDER_PATH, {"tradeSide": "close"}) == "reduce"
      and order._order_intent("POST", order.ORDER_PATH, {"reduceOnly": "YES"}) == "reduce"
      and order._order_intent("POST", order.ORDER_PATH, {"side": "sell"}) == "entry"
      and order._order_intent("POST", order.TPSL_PATH, {}) == "protective"
      and order._order_intent("POST", order.CANCEL_PLAN_PATH, {}) == "cancel", "intent from the body")

# attribution, once filled, rides every signed request
acct.BROKER_CHANNEL_CODE = "blave-test"
del CALLS[:]
order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
check(CALLS and all(c["headers"].get("X-CHANNEL-API-CODE") == "blave-test" for c in CALLS if "ACCESS-KEY" in c["headers"]),
      "a filled channel code rides every signed request (order and reads)")
acct.BROKER_CHANNEL_CODE = ""

# ── limit layer ──────────────────────────────────────────────────────────────


def place_resting(p):
    place(p)
    o = ORDERS[str(9000 + len(POSTS))]
    o.update(state="live", baseVolume="0", priceAvg="")
    if p.get("force") == "post_only" and float(p["price"]) >= 182.12:
        o.update(state="canceled")
    return ok({"orderId": o["orderId"], "clientOid": p["clientOid"]})


route("POST", "/api/v2/mix/order/place-order", place_resting)
res = order.place_limit_order(ENV, "NVDAUSDT", "long", 0.03, 182.106, post_only=True)
check(res["status"] == "open" and POSTS[-1]["force"] == "post_only" and POSTS[-1]["price"] == "182.10"
      and POSTS[-1]["orderType"] == "limit", "post-only limit: force post_only, buy price rounded down", POSTS[-1])
check(order.place_limit_order(ENV, "NVDAUSDT", "long", 0.03, 182.2, post_only=True)["status"] == "post_only_rejected",
      "a post-only Bitget cancelled at once → post_only_rejected")
order.place_limit_order(ENV, "NVDAUSDT", "short", 0.03, 182.301)
check(POSTS[-1]["force"] == "gtc" and POSTS[-1]["price"] == "182.31", "GTC by default; a sell rounds up")
check(order.place_limit_order(ENV, "NVDAUSDT", "long", 0.02, 182.1) is False, "a limit under 5 USDT → False")
o = order.get_order(ENV, "NVDAUSDT", order_id=res["order_id"])
check(o["status"] == "open" and o["orig_qty"] == 0.03 and o["executed_qty"] == 0.0, "get_order: live → open, orig_qty")
route("POST", "/api/v2/mix/order/cancel-order", lambda p: ok({"orderId": p["orderId"]}))
check(order.cancel_order(ENV, "NVDAUSDT", order_id="9100")["status"] == "cancel_accepted", "an accepted cancel is cancel_accepted")
route("POST", "/api/v2/mix/order/cancel-order", lambda p: err("40768", "Order does not exist"))
check(order.cancel_order(ENV, "NVDAUSDT", order_id="9100") == {"status": "order_not_found", "order_id": "9100"},
      "cancelling a gone order → order_not_found, no exception")
route("GET", "/api/v2/mix/order/orders-pending", lambda p: ok({"entrustedList": [
    {"orderId": "77", "clientOid": "rc1", "symbol": "ACNSTOCKUSDT", "side": "buy", "tradeSide": "close", "orderType": "limit",
     "size": "0.03", "price": "240", "reduceOnly": "NO"}], "endId": "77"}))
oo = order.get_open_orders(ENV)
check(oo[0]["symbol"] == "ACNUSDT" and oo[0]["reduce_only"] and oo[0]["client_order_id"] == "rc1",
      "open orders: canonical symbol, client id, a hedge close counts as reduce", oo)
route("GET", "/api/v2/mix/order/orders-pending", lambda p: ok({"entrustedList": None, "endId": None}))
check(order.get_open_orders(ENV, "NVDAUSDT") == [], "no open orders (entrustedList null) → []")

# ── protective (position TP/SL) ──────────────────────────────────────────────
PLANS = {}


def tpsl(p):
    oid = f"p{len(PLANS) + 1}"
    PLANS[oid] = {"orderId": oid, "symbol": p["symbol"], "planType": p["planType"], "triggerPrice": p["triggerPrice"],
                  "side": "sell", "posSide": p["holdSide"]}
    return ok({"orderId": oid, "clientOid": p["clientOid"]})


def plan_pending(p):
    rows = [x for x in PLANS.values() if not p.get("symbol") or x["symbol"] == p["symbol"]]
    return ok({"entrustedList": rows, "endId": None})


def cancel_plan(p):
    ids = [x["orderId"] for x in p["orderIdList"]]
    gone = [i for i in ids if i not in PLANS]
    for i in ids:
        PLANS.pop(i, None)
    return ok({"successList": [{"orderId": i} for i in ids if i not in gone],
               "failureList": [{"orderId": i, "errorCode": "43025", "errorMsg": "Plan order does not exist"} for i in gone]})


route("POST", "/api/v2/mix/order/place-tpsl-order", tpsl)
route("GET", "/api/v2/mix/order/orders-plan-pending", plan_pending)
route("POST", "/api/v2/mix/order/cancel-plan-order", cancel_plan)
del CALLS[:]
placed = order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170.004, tp_price=200.006)
bodies = [c["body"] for c in CALLS if c["path"].endswith("place-tpsl-order")]
check([b["planType"] for b in bodies] == ["pos_loss", "pos_profit"] and bodies[0]["holdSide"] == "buy"
      and bodies[0]["triggerType"] == "mark_price" and bodies[0]["triggerPrice"] == "170.00"
      and bodies[1]["triggerPrice"] == "200.01" and set(placed) == {"sl", "tp"},
      "TP/SL: pos_loss + pos_profit, mark-price trigger on the tick, one-way long holdSide buy", bodies)
check(next(c for c in CALLS if c["query"].get("planType")) ["query"]["planType"] == "profit_loss",
      "verified in the profit_loss plan list")
MODE["posMode"] = "hedge_mode"
order.place_protective_orders(ENV, "NVDAUSDT", "short", sl_price=190)
check([c for c in CALLS if c["path"].endswith("tpsl-order")][-1]["body"]["holdSide"] == "short",
      "hedge short: holdSide short")
MODE["posMode"] = "one_way_mode"
route("POST", "/api/v2/mix/order/place-tpsl-order", lambda p: ok({"orderId": "ghost"}))
try:
    order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170)
    check(False, "an unlisted TP/SL raises ProtectionFailed")
except order.ProtectionFailed as e:
    check("naked" in str(e), "accepted but not in the plan list → ProtectionFailed (naked)")
route("POST", "/api/v2/mix/order/place-tpsl-order", tpsl)
guard.trip_halt("test", "user")
try:
    order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170)
    check(False, "HALT blocks a new TP/SL")
except order.ProtectionFailed:
    check(True, "a TP/SL refused by HALT surfaces as ProtectionFailed (the position may be naked)")
guard.clear_halt("test")
route("POST", "/api/v2/mix/order/place-order", place)
res = order.open_position(ENV, "NVDAUSDT", "long", 0.03, sl_price=170, tp_price=200)
check(res["entry"]["executed_qty"] == 0.03 and set(res["protection"]) == {"sl", "tp"}, "open_position: fill, then both legs")

# sweep: a symbol holding nothing loses its TP/SL; a held one keeps them
PLANS.clear()
PLANS["s1"] = {"orderId": "s1", "symbol": "NVDAUSDT", "planType": "pos_loss", "triggerPrice": "170", "posSide": "long"}
PLANS["s2"] = {"orderId": "s2", "symbol": "ACNSTOCKUSDT", "planType": "pos_profit", "triggerPrice": "300", "posSide": "long"}
POS[:] = [{"symbol": "ACNSTOCKUSDT", "holdSide": "long", "total": "0.03", "available": "0.03", "markPrice": "250"}]
swept = order.sweep_orphan_stops(ENV, acct.get_positions(ENV))
check(swept == ["NVDAUSDT"] and set(PLANS) == {"s2"}, "sweep: a flat symbol's TP/SL cancelled, a held symbol's kept", (swept, PLANS))
check(order.sweep_orphan_stops(ENV, []) == [] and "s2" in PLANS,
      "a round read that misses a held position does not cancel — the venue is re-read first")
route("GET", "/api/v2/mix/order/orders-plan-pending", lambda p: err("40015", "System is abnormal"))
check(order.sweep_orphan_stops(ENV, []) == [], "an unreadable plan list skips the sweep, never raises")
route("GET", "/api/v2/mix/order/orders-plan-pending", plan_pending)
check(order.cancel_algo_order(ENV, "NVDAUSDT", "nope", "pos_loss")["status"] == "order_not_found",
      "cancelling a gone plan order (failureList 43025) → order_not_found")
route("POST", "/api/v2/mix/order/cancel-plan-order", lambda p: ok({"successList": [], "failureList": []}))
check(order.cancel_algo_order(ENV, "NVDAUSDT", "nope", "pos_loss")["status"] == "order_not_found",
      "an unknown plan id answered with both lists empty (measured R9) and absent from the open list → order_not_found")
PLANS["still"] = {"orderId": "still", "symbol": "NVDAUSDT", "planType": "pos_loss", "triggerPrice": "170", "posSide": "long"}
try:
    order.cancel_algo_order(ENV, "NVDAUSDT", "still", "pos_loss")
    check(False, "both lists empty while the plan is still open raises")
except acct.BitgetError:
    check(True, "both lists empty but the plan still listed open → raises (never read as cancelled)")
PLANS.pop("still")
route("POST", "/api/v2/mix/order/cancel-plan-order", cancel_plan)
# one-way close over the held size is refused whole with 40804 (measured): the leg shrank between
# the read and the send — re-read, send what is left; nothing left → False, never an error
MODE["posMode"] = "one_way_mode"
sent = []


def shrink_then_place(p):
    sent.append(p["size"])
    if len(sent) == 1:
        POS[:] = [dict(POS[0], total=shrink_to, available=shrink_to)] if shrink_to != "0" else []
        return err("40804", "The number of closed positions cannot exceed the number of positions held")
    return place(p)


for shrink_to, want_sent, want_res in (("0.02", ["0.05", "0.02"], 0.02), ("0", ["0.05"], False)):
    POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.05", "available": "0.05", "markPrice": "182"}]
    del sent[:]
    route("POST", "/api/v2/mix/order/place-order", shrink_then_place)
    res = order.close_position_partial(ENV, "NVDAUSDT", "long", 0.05)
    got = res if res is False else res["executed_qty"]
    check(sent == want_sent and got == want_res,
          f"one-way close meets 40804 (leg now {shrink_to}): re-read, {'resend the rest' if want_res else 'nothing left → False'}",
          (sent, res))
route("POST", "/api/v2/mix/order/place-order", lambda p: err("40804", "The number of closed positions cannot exceed"))
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.05", "available": "0.05", "markPrice": "182"}]
try:
    order.close_position_partial(ENV, "NVDAUSDT", "long", 0.05)
    check(False, "40804 twice raises")
except acct.BitgetError as e:
    check(str(e).startswith("[order_reject:reduce_only_rejected]"), "40804 that persists: reduce_only_rejected", str(e))
POS[:] = []
route("POST", "/api/v2/mix/order/place-order", place)
route("POST", "/api/v2/mix/order/place-order", lambda p: err("40092", "This service is currently unavailable due to "
                                                              "applicable regulatory requirements or account eligibility"))
try:
    order.place_market_order(ENV, "TWTSMUSDT", "long", 0.08)
    check(False, "40092 raises")
except acct.BitgetError as e:
    check(e.code == "40092" and str(e).startswith("[order_reject:symbol_unavailable]") and "地區或帳戶資格" in str(e),
          "40092 (measured): symbol_unavailable, in words — Bitget's region / eligibility rule, not the strategy", str(e))
    check(acct.ELIGIBILITY_TAG in str(e)[:200] and acct.ELIGIBILITY_TAG in reject_token.to_front("close_symbol: " + str(e))[:200],
          "40092: the fixed [bitget_account_eligibility] marker survives order_errors' 200-char cut (desktop reads it, not the words)", str(e))
route("POST", "/api/v2/mix/order/place-order", place)
route("POST", "/api/v2/mix/order/cancel-order", lambda p: err("43001", "The order does not exist"))
check(order.cancel_order(ENV, "NVDAUSDT", order_id="404")["status"] == "order_not_found",
      "classic cancel refused with 43001 (measured R9) → order_not_found")

# cancel_all is symbol-scoped: never Bitget's account-wide cancel-all-orders
route("GET", "/api/v2/mix/order/orders-pending", lambda p: ok({"entrustedList": [
    {"orderId": "71", "clientOid": "c", "symbol": "ACNSTOCKUSDT", "side": "buy", "orderType": "limit", "size": "0.03",
     "price": "240"}]}))
route("POST", "/api/v2/mix/order/cancel-order", lambda p: ok({"orderId": p["orderId"]}))
del CALLS[:]
out = order.cancel_all_orders(ENV, "ACNUSDT")
check(len(out["orders"]) == 1 and out["algo_orders"][0]["status"] == "canceled" and not PLANS
      and not any(c["path"].endswith("cancel-all-orders") for c in CALLS),
      "cancel_all_orders cancels the symbol's regular + plan orders one by one", out)
POS[:] = []

# ── not live-verified: never auto-wired, no signed request leaves the lib ─────
from lib import venue_traits  # noqa: E402

try:
    order._cid("a:b")
    check(False, "a client id with ':' is refused")
except ValueError:
    check(True, "client ids with ':' or '/' are refused (urlencode would break the GET signature)")
acct.VERIFIED_MODES = frozenset()
del CALLS[:]
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.05", "available": "0.05", "markPrice": "182"}]
for label, fn in (("entry", lambda: order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)),
                  ("close", lambda: order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03)),
                  ("stop-loss", lambda: order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170)),
                  ("cancel", lambda: order.cancel_order(ENV, "NVDAUSDT", order_id="5")),
                  ("equity read", lambda: acct.get_equity(ENV)),
                  ("positions read", lambda: acct.get_positions(ENV)),
                  ("holdings read", lambda: acct.get_holdings(ENV)),
                  ("flows read", lambda: acct.get_flows(ENV, 0)),
                  ("account id", lambda: acct.get_account_id(ENV)),
                  ("signer", lambda: acct.headers(ENV, "GET", "/api/v3/account/settings"))):
    acct._mode.update(mode=None, at=0.0)
    try:
        fn()
        check(False, f"unverified lib: the {label} is refused")
    except (acct.BitgetError, order.ProtectionFailed) as e:
        check("真帳驗證" in str(e) and not any("ACCESS-KEY" in c["headers"] for c in CALLS),
              f"unverified lib: the {label} is refused, no signed request leaves the machine", str(e))
check(acct.classify(acct.BitgetError("x", code=acct.UNVERIFIED)) == "unknown",
      "an unverified refusal classifies UNKNOWN (never TRANSIENT: it does not clear by itself)")
acct.VERIFIED_MODES = BOTH
POS[:] = []
check(venue_traits.verified_modes("bitget") == ("classic", "uta") and "bitget" not in venue_traits.unverified(),
      "venue_traits: bitget verified on classic and UTA accounts (the lib gate reads it)")
from lib import venue_wiring as vw  # noqa: E402

if not os.path.exists("lib"):
    os.symlink(os.path.join(ROOT, "lib"), "lib")  # official_venues looks for lib/account_<id>.py under cwd
check(vw.official_venues(ENV) == ["bitget"] and vw.detect_venue(ENV) == "bitget",
      "a machine with BITGET_* in .env (and both libs on disk): Bitget is wired (a UTA key is refused by the lib)")

# ── lib.venue_wiring on Bitget ───────────────────────────────────────────────
_env, _detect = vw.read_env, vw.detect_venue
vw.read_env, vw.detect_venue = (lambda path=".env": ENV), (lambda env: "bitget")
BINANCE["ONUSDT"] = ("COIN", "ON")
CONTRACTS.append(contract("ONUSDT", "ON"))  # a stock perp under a name Binance has as a coin
acct._instruments.update(rows=None, at=0.0)
try:
    vw.instrument_gate("ONUSDT")
    check(False, "the gate refuses a stock perp Binance has as a coin")
except RuntimeError as e:
    check("股票合約" in str(e), "instrument gate: a Bitget stock perp under a Binance coin's name is refused")
check(vw.instrument_gate("NVDAUSDT") is None and vw.instrument_gate("BTCUSDT") is None,
      "instrument gate: a stock on a stock and a coin on a coin pass")
BINANCE["BTCUSDT"] = ("EQUITY", "BTC")
try:
    order.place_market_order(ENV, "BTCUSDT", "long", 0.001)
    check(False, "a Binance stock name with no Bitget stock row is refused")
except ValueError as e:
    check("symbol_unavailable" in str(e), "a Binance stock name Bitget only has as a coin never trades the coin")
BINANCE["BTCUSDT"] = ("COIN", "BTC")
calls = []
_sweep = order.sweep_orphan_stops
order.sweep_orphan_stops = lambda env, pos: calls.append(pos)
POS[:] = [{"symbol": "NVDAUSDT", "holdSide": "short", "total": "0.03", "available": "0.03", "markPrice": "182"}]
out = vw.auto_get_positions()
check(len(calls) == 1 and out.get("NVDAUSDT", {}).get("side") == "short", "auto_get_positions runs the TP/SL sweep each round", out)
order.sweep_orphan_stops, vw.read_env, vw.detect_venue = _sweep, _env, _detect


# ══ UTA (v3) ═════════════════════════════════════════════════════════════════
# Shapes: Bitget's UTA docs (settings / assets / current-position / order-info / unfilled /
# strategy) and the replies ccxt's bitget.py records; values ours.
import time as _time  # noqa: E402

SETTINGS = {"uid": "5151", "accountMode": "unified", "assetMode": "multi_assets", "holdMode": "one_way_mode",
            "stpMode": "none", "symbolConfigList": [], "coinConfigList": []}
route("GET", "/api/v3/account/settings", lambda p: ok(dict(SETTINGS)))
UPOS = []
route("GET", "/api/v3/position/current-position",
      lambda p: ok({"list": [x for x in UPOS if not p.get("symbol") or x["symbol"] == p["symbol"]]}))
route("GET", "/api/v2/mix/position/all-position",
      lambda p: err("40085", "You are in Unified Account mode, and the Classic Account API is not supported at this time"))


def upos(sym, side, total, avail=None, mark="182"):
    return {"category": "USDT-FUTURES", "symbol": sym, "marginCoin": "USDT", "holdMode": SETTINGS["holdMode"],
            "posSide": side, "marginMode": "crossed", "positionBalance": "5.4", "available": avail or total,
            "frozen": "0", "total": total, "leverage": "5", "avgPrice": "180", "positionStatus": "normal",
            "unrealisedPnl": "0.06", "markPrice": mark}


def fresh_mode():
    acct._mode.update(mode=None, at=0.0)
    if os.path.exists(acct.MODE_PATH):
        os.remove(acct.MODE_PATH)


# ── mode detection ───────────────────────────────────────────────────────────
fresh_mode()
check(acct.account_mode(ENV) == "uta" and acct.switch_hold_left() > 0,
      "accountMode unified → 'uta'; the first mode a machine ever reads opens the hold (conservative)")
acct.get_positions(ENV)
check(acct.switch_hold_left() == 0, "…a first read with nothing recorded releases once the minimum has passed")
fresh_mode()
SETTINGS["accountMode"] = "hybrid"
try:
    acct.account_mode(ENV)
    check(False, "an unmeasured account mode is refused")
except acct.BitgetError as e:
    check(acct.classify(e) == "unknown" and "hybrid" in str(e),
          "accountMode hybrid (not measured) → refused in words (UNKNOWN), never a guessed API", str(e))
SETTINGS["accountMode"] = "unified"
fresh_mode()
acct.account_mode(ENV)
acct.get_positions(ENV)

# ── equity / holdings / account id ───────────────────────────────────────────
ASSETS = {"accountEquity": "160.2", "usdtEquity": "160.3", "unrealisedPnl": "0.06", "effEquity": "150",
          "assets": [{"coin": "USDT", "equity": "100.06", "usdValue": "100.05", "balance": "100", "available": "90",
                      "debt": "0", "locked": "0"},
                     {"coin": "BTC", "equity": "0.0007", "usdValue": "56.7", "balance": "0.0007", "available": "0.0007",
                      "debt": "0", "locked": "0"}]}
route("GET", "/api/v3/account/assets", lambda p: ok(ASSETS))
route("GET", "/api/v3/account/funding-assets",
      lambda p: ok([{"coin": "USDT", "balance": "12", "available": "12", "frozen": "0"},
                    {"coin": "BGB", "balance": "3", "available": "3", "frozen": "0"}]))
route("GET", "/api/v2/spot/market/tickers", lambda p: ok([{"symbol": "BTCUSDT", "lastPr": "81000"},
                                                          {"symbol": "BGBUSDT", "lastPr": "5"}]))
eq = acct.get_equity(ENV)
check(eq == {"equity": 100.06, "currency": "USDT", "accounts": {"unified": 100.06, "funding": 12.0}},
      "UTA equity = the USDT asset's equity (not usdtEquity, which counts BTC too); funding in the breakdown only", eq)
h = acct.get_holdings(ENV)
check([(x["asset"], x["wallet"]) for x in h] == [("BTC", "unified"), ("BGB", "funding"), ("USDT", "funding")]
      and abs(h[0]["usdt_value"] - 56.7) < 1e-9,
      "UTA holdings: the unified non-USDT coins + the funding account (the unified USDT is the equity, not listed)", h)
route("GET", "/api/v3/account/assets", lambda p: ok({"accountEquity": "0", "assets": []}))
check(acct.get_equity(ENV)["equity"] == 0.0, "UTA: no USDT asset = equity 0, not an error")
for bad in (None, {"assets": None}, {"assets": "x"}, []):
    route("GET", "/api/v3/account/assets", lambda p, bad=bad: ok(bad))
    try:
        acct.get_equity(ENV)
        check(False, f"an assets reply {bad!r} raises")
    except acct.BitgetError:
        check(True, f"UTA assets reply {bad!r} raises")
route("GET", "/api/v3/account/assets", lambda p: ok(ASSETS))
check(acct.get_account_id(ENV) == "5151", "UTA get_account_id = the settings' uid")

# ── positions ────────────────────────────────────────────────────────────────
UPOS[:] = [upos("ACNSTOCKUSDT", "long", "0.03", mark="250.2"), upos("NVDAUSDT", "short", "0.02")]
pos = acct.get_positions(ENV)
check([(p["symbol"], p["side"], p["size"], p["mark_price"]) for p in pos]
      == [("ACNUSDT", "long", 0.03, 250.2), ("NVDAUSDT", "short", 0.02, 182.0)]
      and pos[0]["entry_price"] == 180.0 and pos[0]["unrealized_pnl"] == 0.06 and pos[0]["margin"] == 5.4,
      "UTA positions: posSide / total / markPrice / avgPrice / unrealisedPnl, canonical names", pos)
route("GET", "/api/v3/position/current-position", lambda p: ok({"list": None}))
check(acct.get_positions(ENV) == [] and acct.uta_position_rows(ENV, "NVDAUSDT") == [],
      "UTA flat account: data.list null (measured on a real UTA) reads as no positions")
for bad in (None, {}, {"list": "x"}, []):
    route("GET", "/api/v3/position/current-position", lambda p, bad=bad: ok(bad))
    try:
        acct.get_positions(ENV)
        check(False, f"a positions reply {bad!r} raises")
    except acct.BitgetError:
        check(True, f"UTA positions reply {bad!r} raises — never read as flat")
route("GET", "/api/v3/position/current-position",
      lambda p: ok({"list": [x for x in UPOS if not p.get("symbol") or x["symbol"] == p["symbol"]]}))
UPOS[:] = [upos("NVDAUSDT", "long", "0.02", mark="0")]
try:
    acct.get_positions(ENV)
    check(False, "a UTA position without mark raises")
except acct.BitgetError:
    check(True, "UTA: a non-zero position without markPrice raises (never read as flat)")
UPOS[:] = []

# ── orders: THE SIDE TABLE ───────────────────────────────────────────────────
UORD = {}
UPOSTS = []


def uplace(p):
    UPOSTS.append(p)
    oid = str(7000 + len(UPOSTS))
    UORD[oid] = {"orderId": oid, "clientOid": p["clientOid"], "category": "USDT-FUTURES", "symbol": p["symbol"],
                 "orderType": p["orderType"], "side": p["side"], "posSide": p.get("posSide", ""),
                 "qty": p["qty"], "cumExecQty": p["qty"], "avgPrice": "182.11", "orderStatus": "filled",
                 "reduceOnly": "YES" if p.get("reduceOnly") == "yes" else "NO",
                 "feeDetail": [{"feeCoin": "USDT", "fee": "-0.0033"}], "cancelReason": ""}
    return ok({"orderId": oid, "clientOid": p["clientOid"]})


def UORD_BY_CID(cid):
    return next(k for k, x in UORD.items() if x["clientOid"] == cid)


def uinfo(p):
    o = UORD.get(p.get("orderId")) or next((x for x in UORD.values() if x["clientOid"] == p.get("clientOid")), None)
    return ok(o) if o else err("25204", "Order does not exist")


route("POST", "/api/v3/trade/place-order", uplace)
route("GET", "/api/v3/trade/order-info", uinfo)
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0399, client_order_id="rcuta0001")
b = UPOSTS[-1]
check(b == {"category": "USDT-FUTURES", "symbol": "NVDAUSDT", "qty": "0.03", "orderType": "market",
            "clientOid": "rcuta0001", "side": "buy"}
      and not any(c["path"].startswith("/api/v2/mix/order") for c in CALLS),
      "UTA one-way entry long: v3 place-order, qty base on the step, no marginCoin / productType / posSide", b)
check(res == {"avg_price": 182.11, "executed_qty": 0.03, "commission": 0.0033, "order_id": "7001"},
      "UTA fill read off order-info (cumExecQty, avgPrice, feeDetail as a positive cost)", res)
# a UTA fills a filled clientOid again (measured T2): uplace, like Bitget, does not refuse it
n = len(UPOSTS)
again = order.place_market_order(ENV, "NVDAUSDT", "long", 0.0399, client_order_id="rcuta0001")
check(len(UPOSTS) == n and again["order_id"] == "7001",
      "UTA: the same clientOid again → the earlier order is returned, nothing re-sent (no double fill)", again)
route("GET", "/api/v3/trade/order-info", lambda p: err("40010", "Request timed out"))
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03, client_order_id="rcutaunk")
    check(False, "a clientOid lookup that fails raises")
except acct.BitgetError:
    check(len(UPOSTS) == n, "UTA: a clientOid lookup that fails (40010) → raised, nothing sent")
route("GET", "/api/v3/trade/order-info", uinfo)

# Every combination, both APIs, both position modes: (api, hold mode, direction, reduce) → body
# fields and the intent lib/guard reads off that body. A UTA hedge close copied from the classic
# rule (side = the leg) would be buy + posSide long = an OPEN long: this table must stay exact.
WANT = {
    ("classic", "hedge", "long", False): ({"side": "buy", "tradeSide": "open"}, "entry"),
    ("classic", "hedge", "long", True): ({"side": "buy", "tradeSide": "close"}, "reduce"),
    ("classic", "hedge", "short", False): ({"side": "sell", "tradeSide": "open"}, "entry"),
    ("classic", "hedge", "short", True): ({"side": "sell", "tradeSide": "close"}, "reduce"),
    ("classic", "oneway", "long", False): ({"side": "buy"}, "entry"),
    ("classic", "oneway", "long", True): ({"side": "sell", "reduceOnly": "YES"}, "reduce"),
    ("classic", "oneway", "short", False): ({"side": "sell"}, "entry"),
    ("classic", "oneway", "short", True): ({"side": "buy", "reduceOnly": "YES"}, "reduce"),
    ("uta", "hedge", "long", False): ({"side": "buy", "posSide": "long"}, "entry"),
    ("uta", "hedge", "long", True): ({"side": "sell", "posSide": "long"}, "reduce"),
    ("uta", "hedge", "short", False): ({"side": "sell", "posSide": "short"}, "entry"),
    ("uta", "hedge", "short", True): ({"side": "buy", "posSide": "short"}, "reduce"),
    ("uta", "oneway", "long", False): ({"side": "buy"}, "entry"),
    ("uta", "oneway", "long", True): ({"side": "sell", "reduceOnly": "yes"}, "reduce"),
    ("uta", "oneway", "short", False): ({"side": "sell"}, "entry"),
    ("uta", "oneway", "short", True): ({"side": "buy", "reduceOnly": "yes"}, "reduce"),
}
bad = []
for (api, pm, d, red), (fields, intent) in WANT.items():
    got = order._sides(d, red, pm, api)
    path = order.V3_ORDER_PATH if api == "uta" else order.ORDER_PATH
    if got != fields or order._order_intent("POST", path, got) != intent:
        bad.append(((api, pm, d, red), got, order._order_intent("POST", path, got)))
check(not bad and len(WANT) == 16, "side table: 16 cases (2 APIs × 2 position modes × 2 legs × open/close) "
      "give the documented body and the right guard intent", bad)
check(order.UTA_HEDGE_REDUCE_ONLY is False,
      "UTA hedge closes carry no reduceOnly (Bitget refuses it next to posSide: 25238, measured T3)")
check(acct.REJECT_CODES.get("25238") == acct.reject_token.REDUCE_ONLY_REJECTED,
      "25238 is in the reject table as reduce_only_rejected")

# the same through the order functions, hedge mode
SETTINGS["holdMode"] = "hedge_mode"
order.place_market_order(ENV, "NVDAUSDT", "short", 0.03)
check(UPOSTS[-1]["side"] == "sell" and UPOSTS[-1]["posSide"] == "short" and "reduceOnly" not in UPOSTS[-1],
      "UTA hedge open short: sell + posSide short")
UPOS[:] = [upos("NVDAUSDT", "long", "0.05", avail="0.04")]
order.close_position_partial(ENV, "NVDAUSDT", "long", 0.09)
check(UPOSTS[-1]["side"] == "sell" and UPOSTS[-1]["posSide"] == "long" and "reduceOnly" not in UPOSTS[-1]
      and UPOSTS[-1]["qty"] == "0.04", "UTA hedge close long: SELL + posSide long, no reduceOnly, capped at available "
      "(the only over-close guard there)", UPOSTS[-1])
UPOS[:] = [upos("NVDAUSDT", "short", "0.05")]
n = len(UPOSTS)
check(order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03) is False and len(UPOSTS) == n,
      "UTA hedge: closing the long leg while only a short is held → False, nothing sent (never the short leg)")
order.close_position_partial(ENV, "NVDAUSDT", "short", 0.03)
check(UPOSTS[-1]["side"] == "buy" and UPOSTS[-1]["posSide"] == "short" and "reduceOnly" not in UPOSTS[-1],
      "UTA hedge close short: BUY + posSide short, no reduceOnly")
check(order.get_position_mode(ENV) == "hedge", "UTA position mode = settings holdMode")
SETTINGS["symbolConfigList"] = [{"category": "USDT-FUTURES", "symbol": "NVDAUSDT", "marginMode": "isolated", "leverage": "5"}]
order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
check(UPOSTS[-1].get("marginMode") == "isolated", "UTA: the symbol's configured margin mode is named on the order")
SETTINGS["symbolConfigList"] = []
SETTINGS["holdMode"] = "one_way_mode"
UPOS[:] = [upos("NVDAUSDT", "long", "0.05")]
order.close_position_partial(ENV, "NVDAUSDT", "long", 0.03)
check(UPOSTS[-1]["side"] == "sell" and UPOSTS[-1]["reduceOnly"] == "yes" and "posSide" not in UPOSTS[-1],
      "UTA one-way close long: sell + reduceOnly yes, no posSide")
_n25231 = {"n": 0}


def u25231(p):
    # the leg shrank to 0.02 between the read and the send: Bitget refuses the 0.05 close whole
    _n25231["n"] += 1
    if _n25231["n"] == 1:
        UPOS[:] = [upos("NVDAUSDT", "long", "0.02")]
        return err("25231", "Close quantity cannot exceed the held position quantity")
    return uplace(p)


route("POST", "/api/v3/trade/place-order", u25231)
UPOS[:] = [upos("NVDAUSDT", "long", "0.05")]
res = order.close_position_partial(ENV, "NVDAUSDT", "long", 0.05)
check(res and UPOSTS[-1]["qty"] == "0.02" and _n25231["n"] == 2,
      "UTA one-way close meets 25231 (measured T12): re-read the leg, send what is left", UPOSTS[-1])
route("POST", "/api/v3/trade/place-order", lambda p: err("25231", "Close quantity cannot exceed the held position quantity"))
try:
    order.close_position_partial(ENV, "NVDAUSDT", "long", 0.02)
    check(False, "25231 twice raises")
except acct.BitgetError as e:
    check(str(e).startswith("[order_reject:reduce_only_rejected]"), "25231 that persists: reduce_only_rejected", str(e))
route("POST", "/api/v3/trade/place-order", uplace)
UPOS[:] = []

# reply without orderId, dropped POST, HALT, attribution — the v3 transport
def uplace_noid(p):
    uplace(p)
    return ok({"clientOid": p["clientOid"]})


route("POST", "/api/v3/trade/place-order", uplace_noid)
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03, client_order_id="rcutanoid")
check(res and res["executed_qty"] == 0.03 and CALLS[-1]["path"] == "/api/v3/trade/order-info"
      and CALLS[-1]["query"] == {"clientOid": "rcutanoid"}, "UTA reply without orderId: found by clientOid on order-info")


def udrop(p):
    uplace(p)
    return requests.exceptions.ConnectionError("reset")


route("POST", "/api/v3/trade/place-order", udrop)
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03, client_order_id="rcutadrop")
check(res and sum(c["method"] == "POST" for c in CALLS) == 1, "UTA: a POST whose reply died is found by clientOid, never resent")
def u40010(p):
    uplace(p)
    return err("40010", "Request timed out")


route("POST", "/api/v3/trade/place-order", u40010)
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03, client_order_id="rcuta40010")
check(res and sum(c["method"] == "POST" for c in CALLS) == 1,
      "UTA: 40010 (outcome unknown) is looked up by clientOid, never resent")
route("POST", "/api/v3/trade/place-order", lambda p: err("25212", "Duplicate clientOid"))
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03, client_order_id="rcuta40010")
check(res and res["order_id"] == UORD_BY_CID("rcuta40010") and sum(c["method"] == "POST" for c in CALLS) == 0,
      "UTA: a clientOid that already names an order is found before the POST — nothing sent")
_lag = {"n": 0}


def uinfo_lag(p):
    # the earlier send is not readable yet on the first lookup (index lag), then it is
    _lag["n"] += 1
    return err("25204", "Order does not exist") if _lag["n"] == 1 else uinfo(p)


route("GET", "/api/v3/trade/order-info", uinfo_lag)
del CALLS[:]
res = order.place_market_order(ENV, "NVDAUSDT", "long", 0.03, client_order_id="rcuta40010")
check(res and sum(c["method"] == "POST" for c in CALLS) == 1,
      "UTA: 25212 after the pre-lookup missed → looked up again (the earlier send landed), never resent")
route("GET", "/api/v3/trade/order-info", uinfo)
route("POST", "/api/v3/trade/place-order", lambda p: err("43027", "notional below the minimum"))
check(order.place_market_order(ENV, "NVDAUSDT", "long", 0.03) is False, "UTA 43027 below the minimum value → quiet False")
route("POST", "/api/v3/trade/place-order", lambda p: err("12001", "insufficient balance"))
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "12001 raises")
except acct.BitgetError as e:
    check(str(e).startswith("[order_reject:insufficient_margin]"), "UTA 12001 tags insufficient_margin", str(e))
route("POST", "/api/v3/trade/place-order", uplace)
guard.trip_halt("test", "user")
del CALLS[:]
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "HALT refuses a UTA entry")
except guard.Halted:
    check(not any(c["method"] == "POST" for c in CALLS), "HALT refuses a UTA entry before the transport")
guard.clear_halt("test")
acct.BROKER_CHANNEL_CODE = "blave-test"
del CALLS[:]
order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
check(CALLS and all(c["headers"].get("X-CHANNEL-API-CODE") == "blave-test" for c in CALLS if "ACCESS-KEY" in c["headers"]),
      "UTA: a filled channel code rides every signed v3 request")
acct.BROKER_CHANNEL_CODE = ""


# market order cancelled after a partial fill / with nothing
def uplace_state(state, filled):
    def fn(p):
        uplace(p)
        UORD[str(7000 + len(UPOSTS))].update(orderStatus=state, cumExecQty=filled, cancelReason="no_liquidity")
        return ok({"orderId": str(7000 + len(UPOSTS)), "clientOid": p["clientOid"]})
    return fn


route("POST", "/api/v3/trade/place-order", uplace_state("cancelled", "0.01"))
check(order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)["executed_qty"] == 0.01,
      "UTA: a market order cancelled after a partial fill reports the fill")
route("POST", "/api/v3/trade/place-order", uplace_state("cancelled", "0"))
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "UTA: cancelled with nothing filled raises")
except acct.BitgetError as e:
    check("no_liquidity" in str(e), "UTA: a market order cancelled with nothing filled raises with the reason")

# ── limit layer ──────────────────────────────────────────────────────────────
def uplace_rest(p):
    uplace(p)
    o = UORD[str(7000 + len(UPOSTS))]
    o.update(orderStatus="live", cumExecQty="0", avgPrice="", feeDetail=[{"feeCoin": "", "fee": ""}])
    if p.get("timeInForce") == "post_only" and float(p["price"]) >= 182.12:
        o.update(orderStatus="cancelled")
    return ok({"orderId": o["orderId"], "clientOid": p["clientOid"]})


route("POST", "/api/v3/trade/place-order", uplace_rest)
res = order.place_limit_order(ENV, "NVDAUSDT", "long", 0.03, 182.106, post_only=True)
check(res["status"] == "open" and UPOSTS[-1]["timeInForce"] == "post_only" and UPOSTS[-1]["price"] == "182.10"
      and "force" not in UPOSTS[-1], "UTA post-only limit: timeInForce post_only (not force), buy rounded down", UPOSTS[-1])
check(order.place_limit_order(ENV, "NVDAUSDT", "long", 0.03, 182.2, post_only=True)["status"] == "post_only_rejected",
      "UTA: a post-only Bitget cancelled at once → post_only_rejected")
o = order.get_order(ENV, "NVDAUSDT", order_id=res["order_id"])
check(o["status"] == "open" and o["orig_qty"] == 0.03 and o["executed_qty"] == 0.0 and o["commission"] is None,
      "UTA get_order: live → open, qty → orig_qty, empty fee → None", o)
route("POST", "/api/v3/trade/cancel-order", lambda p: ok({"orderId": p.get("orderId"), "clientOid": ""}))
del CALLS[:]
check(order.cancel_order(ENV, "NVDAUSDT", order_id=res["order_id"])["status"] == "cancel_accepted"
      and CALLS[-1]["body"] == {"category": "USDT-FUTURES", "orderId": res["order_id"]},
      "UTA cancel: orderId + category, accepted → cancel_accepted")
route("POST", "/api/v3/trade/cancel-order", lambda p: err("25204", "order does not exist"))
UORD[res["order_id"]]["orderStatus"] = "filled"
check(order.cancel_order(ENV, "NVDAUSDT", order_id=res["order_id"])["status"] == "order_not_found",
      "UTA: a refused cancel of an order that has filled → order_not_found")
check(order.cancel_order(ENV, "NVDAUSDT", order_id="nope")["status"] == "order_not_found",
      "UTA: a refused cancel of an order Bitget cannot find → order_not_found")
for label, reply in (("rate-limited", err("429", "Too Many Requests", 429)),
                     ("HTTP 500, not JSON", Resp("<html>bad gateway</html>", 500)),
                     ("40010", err("40010", "Request timed out")),
                     ("40008", err("40008", "Request timestamp expired"))):
    route("GET", "/api/v3/trade/order-info", lambda p, r=reply: r)
    try:
        out = order.cancel_order(ENV, "NVDAUSDT", order_id=res["order_id"])
        check(False, f"a refused cancel whose read-back is {label} raises", out)
    except acct.BitgetError:
        check(True, f"UTA: a refused cancel whose read-back is {label} raises — never order_not_found (no re-place)")
route("GET", "/api/v3/trade/order-info", lambda p: ok(None))
check(order.cancel_order(ENV, "NVDAUSDT", order_id=res["order_id"])["status"] == "order_not_found",
      "UTA: a refused cancel whose read-back answers success with no order → order_not_found")
route("GET", "/api/v3/trade/order-info", lambda p: err("25204", "Order does not exist"))
check(order.cancel_order(ENV, "NVDAUSDT", order_id="1")["status"] == "order_not_found",
      "UTA: cancel and read-back both 25204 (measured R9) → order_not_found")
route("GET", "/api/v3/trade/order-info", uinfo)
UORD[res["order_id"]]["orderStatus"] = "live"
try:
    order.cancel_order(ENV, "NVDAUSDT", order_id=res["order_id"])
    check(False, "a refused cancel of a still-open order raises")
except acct.BitgetError:
    check(True, "UTA: a refused cancel of an order that is still open raises")
route("GET", "/api/v3/trade/unfilled-orders", lambda p: ok({"list": [
    {"orderId": "88", "clientOid": "rc2", "category": "USDT-FUTURES", "symbol": "ACNSTOCKUSDT", "orderType": "limit",
     "side": "sell", "posSide": "long", "price": "260", "qty": "0.03", "cumExecQty": "0", "orderStatus": "live",
     "reduceOnly": "NO"}], "cursor": "88"}))
oo = order.get_open_orders(ENV)
check(oo[0]["symbol"] == "ACNUSDT" and oo[0]["reduce_only"] and oo[0]["qty"] == 0.03 and oo[0]["client_order_id"] == "rc2",
      "UTA open orders: data.list, canonical symbol, a sell on posSide long counts as reduce", oo)
route("GET", "/api/v3/trade/unfilled-orders", lambda p: ok({"list": None, "cursor": None}))
check(order.get_open_orders(ENV) == [], "UTA open orders: data.list null = none")

# ── protective (tpsl strategy orders) ────────────────────────────────────────
# As measured 2026-10-23: one tpsl full order per leg; a second place on the leg rewrites it in
# place (same orderId, the first clientOid kept, any field it omits emptied).
STRAT = {}


def ustrat(p):
    oid = next((k for k, x in STRAT.items() if x["symbol"] == p["symbol"] and x["side"] == p["side"]), None)
    if oid is None:
        oid = f"u{len(STRAT) + 1}"
        while oid in STRAT:
            oid += "x"
        STRAT[oid] = {"orderId": oid, "clientOid": p["clientOid"]}
    STRAT[oid].update({"category": p["category"], "symbol": p["symbol"], "side": p["side"],
                       "posSide": p["posSide"], "status": "pending",
                       "stopLoss": p.get("stopLoss", ""), "takeProfit": p.get("takeProfit", "")})
    return ok({"orderId": oid, "clientOid": STRAT[oid]["clientOid"]})


def ustrat_list(p):
    return ok({"list": [x for x in STRAT.values() if p.get("type") in (None, "tpsl")]})


def ustrat_cancel(p):
    if p["orderId"] not in STRAT:
        return err("25575", "Failed to stop the strategy because the corresponding strategy ID could not be found")
    STRAT.pop(p["orderId"])
    return ok(None)


def strat_posts():
    return [c["body"] for c in CALLS if c["path"] == "/api/v3/trade/place-strategy-order"]


route("POST", "/api/v3/trade/place-strategy-order", ustrat)
route("GET", "/api/v3/trade/unfilled-strategy-orders", lambda p: ok({"list": None, "cursor": None}))
check(order.get_open_algo_orders(ENV) == [], "UTA strategy orders: data.list null = none")
route("GET", "/api/v3/trade/unfilled-strategy-orders", ustrat_list)
route("POST", "/api/v3/trade/cancel-strategy-order", ustrat_cancel)
del CALLS[:]
placed = order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170.004, tp_price=200.006)
bodies = strat_posts()
al = order.get_open_algo_orders(ENV, "NVDAUSDT")
check(len(bodies) == 1 and set(placed) == {"sl", "tp"} and placed["sl"]["algoId"] == placed["tp"]["algoId"]
      and bodies[0]["type"] == "tpsl" and bodies[0]["tpslMode"] == "full" and bodies[0]["side"] == "sell"
      and bodies[0]["posSide"] == "long" and bodies[0]["stopLoss"] == "170.00" and bodies[0]["slTriggerBy"] == "mark"
      and bodies[0]["slOrderType"] == "market" and bodies[0]["takeProfit"] == "200.01"
      and bodies[0]["tpTriggerBy"] == "mark" and bodies[0]["tpOrderType"] == "market",
      "UTA TP/SL on a long: ONE tpsl full order carrying both, side SELL (closing) + posSide long, mark trigger", bodies)
check(sorted((x["stop_order_type"], x["trigger_price"]) for x in al) == [("pos_loss", 170.0), ("pos_profit", 200.01)]
      and len({x["order_id"] for x in al}) == 1,
      "UTA open TP/SL: the one order is listed once per kind (SL and TP both visible, same id)", al)
del CALLS[:]
order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=175)
b = strat_posts()[-1]
al = order.get_open_algo_orders(ENV, "NVDAUSDT")
check(b["stopLoss"] == "175.00" and b["takeProfit"] == "200.01"
      and sorted((x["stop_order_type"], x["trigger_price"]) for x in al) == [("pos_loss", 175.0), ("pos_profit", 200.01)],
      "UTA: moving the SL alone carries the leg's TP over (a place without it would empty it on Bitget)", b)
SETTINGS["holdMode"] = "hedge_mode"
order.place_protective_orders(ENV, "NVDAUSDT", "short", sl_price=190)
b = strat_posts()[-1]
check(b["side"] == "buy" and b["posSide"] == "short" and b["stopLoss"] == "190.00" and "takeProfit" not in b
      and len(STRAT) == 2, "UTA TP/SL on a short: side BUY + posSide short, its own order (the long's kept)", b)
SETTINGS["holdMode"] = "one_way_mode"
SETTINGS["symbolConfigList"] = [{"category": "USDT-FUTURES", "symbol": "NVDAUSDT", "marginMode": "isolated"}]
order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=171)
b = strat_posts()[-1]
check(b.get("marginMode") == "isolated", "UTA TP/SL on an isolated symbol names marginMode (UTA error 31008 otherwise)")
SETTINGS["symbolConfigList"] = []


def ustrat_drop_tp(p):
    return ustrat({k: v for k, v in p.items() if not k.startswith("tp") and k != "takeProfit"})


route("POST", "/api/v3/trade/place-strategy-order", ustrat_drop_tp)
try:
    order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170, tp_price=210)
    check(False, "UTA: a TP the order does not carry raises")
except order.ProtectionFailed:
    check(True, "UTA: accepted but the listed order lacks the TP → ProtectionFailed (checked per kind, not per id)")
route("POST", "/api/v3/trade/place-strategy-order", lambda p: ok({"orderId": "ghost"}))
try:
    order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170)
    check(False, "UTA: an unlisted TP/SL raises")
except order.ProtectionFailed:
    check(True, "UTA: a TP/SL accepted but not pending → ProtectionFailed")
route("POST", "/api/v3/trade/place-strategy-order", ustrat)
order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170, tp_price=210)
del CALLS[:]
res = order.cancel_protective_orders(ENV, "NVDAUSDT")
cancels = [c for c in CALLS if c["path"] == "/api/v3/trade/cancel-strategy-order"]
check(len(cancels) == 2 and all(r["status"] == "canceled" for r in res) and not STRAT,
      "UTA cancel_protective_orders: each order cancelled once (long + short), not once per kind", (cancels, res))
check(order.cancel_algo_order(ENV, "NVDAUSDT", "u1")["status"] == "order_not_found",
      "UTA: cancelling a TP/SL that is gone → order_not_found")
order.place_protective_orders(ENV, "NVDAUSDT", "long", sl_price=170, tp_price=210)
UPOS[:] = [upos("ACNSTOCKUSDT", "long", "0.03", mark="250")]
STRAT["u9"] = {"orderId": "u9", "symbol": "ACNSTOCKUSDT", "side": "sell", "posSide": "long", "status": "pending",
               "stopLoss": "200", "takeProfit": ""}
del CALLS[:]
swept = order.sweep_orphan_stops(ENV, acct.get_positions(ENV))
cancels = [c for c in CALLS if c["path"] == "/api/v3/trade/cancel-strategy-order"]
check(swept == ["NVDAUSDT"] and set(STRAT) == {"u9"} and len(cancels) == 1,
      "UTA sweep: a flat symbol's TP/SL order cancelled once, a held symbol's kept", (swept, STRAT))
UPOS[:] = []

# ── flows ────────────────────────────────────────────────────────────────────
UWIN = []


def urecords(rows):
    def fn(p):
        UWIN.append((int(p["startTime"]), int(p["endTime"])))
        return ok([r for r in rows if int(p["startTime"]) <= int(r["createdTime"]) <= int(p["endTime"])])
    return fn


route("GET", "/api/v3/account/deposit-records", urecords([
    {"orderId": "1", "recordId": "0xdep", "coin": "USDT", "type": "deposit", "size": "30", "status": "success",
     "dest": "on_chain", "createdTime": "1792000000000"},
    {"orderId": "2", "recordId": "x", "coin": "USDT", "type": "deposit", "size": "5", "status": "success",
     "dest": "internal_transfer", "createdTime": "1792000100000"}]))
route("GET", "/api/v3/account/withdrawal-records", urecords([
    {"orderId": "3", "recordId": "0xwd", "coin": "USDT", "type": "withdraw", "size": "30", "fee": "-1.5",
     "status": "success", "dest": "on_chain", "createdTime": "1792000200000"},
    {"orderId": "4", "recordId": "0xpend", "coin": "USDT", "type": "withdraw", "size": "9", "status": "pending",
     "dest": "on_chain", "createdTime": "1792000300000"}]))
_now = acct._now_ms
acct._now_ms = lambda: 1792100000000
fl = acct.get_flows(ENV, (1792100000000 - 89 * 86400 * 1000) // 1000)
acct._now_ms = _now
check(fl == [{"ts": 1792000000, "direction": "in", "currency": "USDT", "amount": 30.0, "txid": "0xdep"},
             {"ts": 1792000200, "direction": "out", "currency": "USDT", "amount": 30.0, "txid": "0xwd"}],
      "UTA flows: on-chain + success only, recordId is the txid, createdTime the time", fl)
check(UWIN and all(e - s <= acct.UTA_FLOW_WINDOW_MS for s, e in UWIN) and len(UWIN) == 8,
      "UTA flows: 30-day windows (4 per endpoint over 89 days)", UWIN)

# ── classify ─────────────────────────────────────────────────────────────────
check(acct.classify(acct.BitgetError("x", code="40085")) == "transient"
      and acct.classify(acct.BitgetError("x", code=acct.MODE_SWITCH)) == "transient"
      and acct.classify(acct.BitgetError("x", code=acct.MODE_UNSUPPORTED)) == "unknown",
      "40085 and a mode switch are TRANSIENT (the round is skipped, never HALT); an unsupported mode is UNKNOWN")

# ── a classic account upgraded to UTA while running ──────────────────────────
from lib import events as _events  # noqa: E402

EMITS = []
_events.emit = lambda ev_type, **payload: EMITS.append((ev_type, payload))


def halt_file():
    try:
        with open(guard.HALT_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def user_resume():
    guard.clear_halt("test")  # what 啟動下單 does (command_listener resume)


def our_stops(*legs, cancelled=()):
    """state/audit.jsonl as lib/order_bitget leaves it: a classic pos_loss placed on each
    (symbol, side) leg (one-way: holdSide buy/sell), then the cancels of `cancelled` ids."""
    with open(guard.AUDIT_PATH, "w") as f:
        f.write(json.dumps({"event": "order_ok", "venue": "okx", "intent": "protective", "symbol": "NVDAUSDT",
                            "planType": "pos_loss", "holdSide": "long", "order_id": "okx1"}) + "\n")
        for i, (sym, side) in enumerate(legs):
            f.write(json.dumps({"event": "order_ok", "venue": "bitget", "intent": "protective", "symbol": sym,
                                "planType": "pos_loss", "holdSide": "buy" if side == "long" else "sell",
                                "order_id": f"sl{i}"}) + "\n")
        f.write("{torn\n")
        for oid in cancelled:
            f.write(json.dumps({"event": "order_ok", "venue": "bitget", "intent": "cancel", "symbol": "x",
                                "orderId": oid, "order_id": ""}) + "\n")


def classic_with(rows, stops=()):
    """A classic machine that recorded `rows` (v2 position rows) as its legs, with this lib's
    stop-losses `stops` on record, then Bitget upgrades it."""
    our_stops(*stops)
    fresh_mode()
    acct.SWITCH_HOLD_S = 0
    SETTINGS["accountMode"] = "__classic__"
    route("GET", "/api/v3/account/settings",
          lambda p: err("40084", "not a unified account") if SETTINGS["accountMode"] == "__classic__" else ok(dict(SETTINGS)))
    route("GET", "/api/v2/mix/account/accounts", lambda p: ok([{"marginCoin": "USDT", "accountEquity": "50"}]))
    route("GET", "/api/v2/mix/position/all-position", lambda p: ok(rows))
    acct.get_positions(ENV)
    acct.SWITCH_HOLD_S = 120
    SETTINGS["accountMode"] = "unified"
    route("GET", "/api/v2/mix/position/all-position",
          lambda p: err("40085", "You are in Unified Account mode, and the Classic Account API is not supported at this time"))
    acct._mode.update(mode=None, at=0.0)
    acct.account_mode(ENV)  # the first read after the upgrade opens the hold


def age_hold(seconds):
    st = acct._read_mode()
    st["hold"]["since"] = _time.time() - seconds
    acct._write_mode(st)


def judged():
    """One read past the minimum hold: ('ok', positions) or ('err', the BitgetError)."""
    age_hold(acct.SWITCH_HOLD_S + 1)
    try:
        return "ok", acct.get_positions(ENV)
    except acct.BitgetError as e:
        return "err", e


V2_NVDA = {"symbol": "NVDAUSDT", "holdSide": "long", "total": "0.03", "available": "0.03", "markPrice": "182"}
V2_ACN = {"symbol": "ACNSTOCKUSDT", "holdSide": "short", "total": "0.05", "available": "0.05", "markPrice": "250"}

classic_with([V2_NVDA])
st = acct._read_mode()
check(st["hold"].get("from") == "classic" and st["hold"].get("await") == [["NVDAUSDT", "long", 0.03]],
      "a classic key: the v3 settings refusal sends the probe to v2 → 'classic'; each leg is recorded with its quantity", st)
# Bitget upgrades the account: v2 private endpoints answer 40085, v3 settings says upgrading
SETTINGS["accountMode"] = "upgrading"
try:
    acct.get_positions(ENV)
    check(False, "positions during an upgrade raise")
except acct.BitgetError as e:
    check(acct.classify(e) == "transient" and "只讀" in str(e),
          "mid-upgrade (accountMode upgrading): the positions read raises TRANSIENT, nothing read as flat", str(e))
SETTINGS["accountMode"] = "unified"
UPOS[:] = []  # the migrating account may answer an empty v3 list for a while
for label in ("the first round after the upgrade", "a later round inside the hold"):
    try:
        acct.get_positions(ENV)
        check(False, f"{label}: positions raise")
    except acct.BitgetError as e:
        check(acct.classify(e) == "transient", f"{label}: get_positions raises TRANSIENT (an empty v3 list is not read)")
check(acct.account_mode(ENV) == "uta" and acct.switch_hold_left() > 0 and acct._read_mode()["hold"].get("from") == "classic",
      "the switch is recorded: mode uta, hold open, switched from classic")
check(order.session_open(ENV, "NVDAUSDT") is False, "during the hold session_open is False (entries held)")
route("POST", "/api/v3/trade/place-order", uplace)
n = len(UPOSTS)
del CALLS[:]
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "an entry during the hold is refused")
except Exception as e:
    check(isinstance(e, acct.BitgetError) and acct.classify(e) == "transient",
          "an entry during the hold raises TRANSIENT", repr(e))
audit_rows = open("state/audit.jsonl").read().splitlines()[-3:]
check(len(UPOSTS) == n and not any(c["method"] == "POST" for c in CALLS)
      and any("order_denied_mode_switch" in r for r in audit_rows),
      "…refused before the transport, audited order_denied_mode_switch")
UPOS[:] = [upos("NVDAUSDT", "long", "0.03")]
order.close_position_partial(ENV, "NVDAUSDT", "long", 0.01)
check(len(UPOSTS) == n + 1 and UPOSTS[-1]["side"] == "sell" and UPOSTS[-1]["reduceOnly"] == "yes",
      "a close during the hold still goes out (capped at the leg, v3 side table)")

STOPS = []
route("GET", "/api/v3/trade/unfilled-strategy-orders", lambda p: ok({"list": list(STOPS), "cursor": None}))


def ustop(sym, closing_side, sl="170"):
    return {"orderId": "9" + sym, "clientOid": "c" + sym, "symbol": sym, "side": closing_side, "posSide": "long",
            "stopLoss": sl, "takeProfit": "", "status": "pending"}


# ① every leg back with the same quantity, the stop-loss Blave placed still on Bitget: resumes, one P3 event, no HALT
STOPS[:] = [ustop("NVDAUSDT", "sell")]
our_stops(("NVDAUSDT", "long"))
del EMITS[:]
kind, pos = judged()
check(kind == "ok" and pos and pos[0]["symbol"] == "NVDAUSDT" and pos[0]["size"] == 0.03 and acct.switch_hold_left() == 0
      and order.session_open(ENV, "NVDAUSDT") and halt_file() is None,
      "① same symbol, side and quantity past the minimum: hold released, entries open, no HALT", (kind, pos))
check(EMITS == [("venue_mode_switched", {"venue": "bitget", "mode": "uta", "legs": 1})],
      "① …our stop-loss still there: one venue_mode_switched event (P3: event list only)", EMITS)
# under one step (NVDAUSDT sizeMultiplier 0.01) is the venue's rounding, the same quantity
classic_with([V2_NVDA])
UPOS[:] = [upos("NVDAUSDT", "long", "0.030004")]
kind, pos = judged()
check(kind == "ok" and halt_file() is None, "① 0.03 read back as 0.030004 (under one 0.01 step) still matches", (kind, pos))

# ①b only the legs Blave itself protected are checked
# a Type A strategy that never placed a stop: nothing missing, Bitget's list not even read
classic_with([V2_NVDA])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03")]
STOPS[:] = []
route("GET", "/api/v3/trade/unfilled-strategy-orders", lambda p: err("40015", "System is abnormal"))
del EMITS[:]
kind, pos = judged()
check(kind == "ok" and EMITS == [("venue_mode_switched", {"venue": "bitget", "mode": "uta", "legs": 1})],
      "①b no stop-loss of ours on record (Type A without stops, another venue's row ignored): P3 only, no P1", EMITS)
route("GET", "/api/v3/trade/unfilled-strategy-orders", lambda p: ok({"list": list(STOPS), "cursor": None}))
# ours on ACN gone after the switch (only a TP left), NVDA's still there: one P1 naming ACN, trading resumes
classic_with([V2_NVDA, V2_ACN], stops=[("NVDAUSDT", "long"), ("ACNSTOCKUSDT", "short")])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03"), upos("ACNSTOCKUSDT", "short", "0.05", mark="250")]
STOPS[:] = [ustop("NVDAUSDT", "sell"), {**ustop("ACNSTOCKUSDT", "buy"), "stopLoss": "", "takeProfit": "200"}]
del EMITS[:]
kind, pos = judged()
check(kind == "ok" and len(pos) == 2 and halt_file() is None and acct.switch_hold_left() == 0
      and EMITS == [("venue_stops_missing", {"venue": "bitget", "mode": "uta", "unreadable": False,
                                             "legs": [{"symbol": "ACNUSDT", "side": "short"}]})],
      "①b our stop-loss on ACN short gone (a take-profit is not one): trading resumes, one venue_stops_missing (P1)", EMITS)
# ours on NVDA still there, ACN never protected by its strategy: ACN is not "missing" a stop
classic_with([V2_NVDA, V2_ACN], stops=[("NVDAUSDT", "long")])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03"), upos("ACNSTOCKUSDT", "short", "0.05", mark="250")]
STOPS[:] = [ustop("NVDAUSDT", "sell")]
del EMITS[:]
judged()
check([e[0] for e in EMITS] == ["venue_mode_switched"],
      "①b a leg whose strategy never placed a stop (ACN) is not checked beside one of ours (NVDA, still there)", EMITS)
# a stop of ours that was cancelled before the switch is not ours any more
classic_with([V2_NVDA])
our_stops(("NVDAUSDT", "long"), cancelled=["sl0"])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03")]
STOPS[:] = []
del EMITS[:]
judged()
check([e[0] for e in EMITS] == ["venue_mode_switched"], "①b a stop of ours cancelled earlier (classic cancel by id): not checked", EMITS)
# a hedge symbol holding both legs, ours on both: on UTA the stop's closing side tells which leg it guards
classic_with([V2_NVDA, {**V2_NVDA, "holdSide": "short"}], stops=[("NVDAUSDT", "long"), ("NVDAUSDT", "short")])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03"), upos("NVDAUSDT", "short", "0.03")]
STOPS[:] = [ustop("NVDAUSDT", "sell")]
del EMITS[:]
judged()
check([e[1]["legs"] for e in EMITS if e[0] == "venue_stops_missing"] == [[{"symbol": "NVDAUSDT", "side": "short"}]],
      "①b both NVDA legs ours, one stop that closes by selling: the long is covered, the short is listed", EMITS)
# both NVDA legs held, only the short is ours and its stop is gone; the user's own stop guards the long:
# that stop does not cover our short (counted over every held leg, not only ours)
classic_with([V2_NVDA, {**V2_NVDA, "holdSide": "short"}], stops=[("NVDAUSDT", "short")])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03"), upos("NVDAUSDT", "short", "0.03")]
STOPS[:] = [ustop("NVDAUSDT", "sell")]
del EMITS[:]
judged()
check([e[1]["legs"] for e in EMITS if e[0] == "venue_stops_missing"] == [[{"symbol": "NVDAUSDT", "side": "short"}]],
      "①b hedge, ours on the short gone, the user's stop on the long: not counted as ours, P1 names the short", EMITS)
# classic: the plan list's posSide / holdSide tells the leg (a user's long stop does not cover our short)
route("GET", "/api/v2/mix/order/orders-plan-pending", lambda p: ok({"entrustedList": [
    {"symbol": "NVDAUSDT", "planType": "pos_loss", "posSide": "long", "holdSide": "long", "side": "sell"}]}))
both = [("NVDAUSDT", "long"), ("NVDAUSDT", "short")]
check(acct._unprotected(ENV, "classic", [("NVDAUSDT", "short")], both) == ([("NVDAUSDT", "short")], False)
      and acct._unprotected(ENV, "classic", [("NVDAUSDT", "long")], both) == ([], False)
      and acct._unprotected(ENV, "classic", [("NVDAUSDT", "short")], [("NVDAUSDT", "short")]) == ([], False),
      "①b classic hedge: a stop counts for its own leg only (posSide); one leg held → any stop on the symbol")
# Bitget's plan list cannot be read: our protected legs count as unprotected, flagged unreadable
classic_with([V2_NVDA], stops=[("NVDAUSDT", "long")])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03")]
route("GET", "/api/v3/trade/unfilled-strategy-orders", lambda p: err("40015", "System is abnormal"))
del EMITS[:]
kind, pos = judged()
check(kind == "ok" and halt_file() is None
      and EMITS == [("venue_stops_missing", {"venue": "bitget", "mode": "uta", "unreadable": True,
                                             "legs": [{"symbol": "NVDAUSDT", "side": "long"}]})],
      "①b plan list unreadable: our stop-loss counted as gone (never assumed safe), flagged, trading resumes", EMITS)
route("GET", "/api/v3/trade/unfilled-strategy-orders", lambda p: ok({"list": list(STOPS), "cursor": None}))
# our own record cannot be read: no P1, the P3 line says the stops could not be confirmed
classic_with([V2_NVDA])
os.remove(guard.AUDIT_PATH)
UPOS[:] = [upos("NVDAUSDT", "long", "0.03")]
STOPS[:] = []
del EMITS[:]
judged()
check(EMITS == [("venue_mode_switched", {"venue": "bitget", "mode": "uta", "legs": 1, "stops_unknown": True})],
      "①b audit record missing: no P1, venue_mode_switched carries stops_unknown (「無法確認止損」)", EMITS)
STOPS[:] = [ustop("NVDAUSDT", "sell")]
our_stops()

# ② a different quantity: HALT at once, the leg listed before vs now
classic_with([V2_NVDA])
n_ev = len(EMITS)
UPOS[:] = [upos("NVDAUSDT", "long", "0.02")]
kind, pos = judged()
h = halt_file()
check(kind == "ok" and pos[0]["size"] == 0.02
      and h and h["source"] == "reconciler" and h["reason"].startswith(acct.MISMATCH_TAG)
      and h["mismatch"]["legs"] == [{"symbol": "NVDAUSDT", "side": "long", "before": 0.03, "now": 0.02}]
      and h["mismatch"]["mode"] == "uta",
      "② quantity 0.03 → 0.02 (one step): HALT at once, the leg's both quantities on the HALT; the read itself does not "
      "fail (the HALT is the notice, no reconciler retry message beside it)", (kind, pos, h))
check(acct.switch_hold_left() > 0 and len(EMITS) == n_ev, "② …the hold stays, no resume event")
kind, pos = judged()
check(kind == "ok" and pos[0]["size"] == 0.02 and halt_file() == h,
      "② while that HALT stands the positions read as they are (HALT stops every order), no second HALT")
user_resume()
kind, pos = judged()
check(kind == "ok" and acct.switch_hold_left() == 0 and halt_file() is None
      and acct._read_mode().get("legs") == [["NVDAUSDT", "long", 0.02]] and len(EMITS) == n_ev,
      "② 啟動下單 releases the hold on what Bitget holds now; no resume event (the user resumed)", acct._read_mode())

# two processes judge the same switch: the second finds the first one's mismatch HALT and keeps it (time and
# list), so 啟動下單 releases at once — never a second HALT after the resume
classic_with([V2_NVDA])
UPOS[:] = [upos("NVDAUSDT", "long", "0.02")]
age_hold(acct.SWITCH_HOLD_S + 1)
first = acct._trip_mismatch_halt("uta", [{"symbol": "NVDAUSDT", "side": "long", "before": 0.03, "now": 0.02}])
h1 = halt_file()  # process A tripped it; process B read the mode file before A recorded its hold
acct.get_positions(ENV)
check(halt_file() == h1 and acct._read_mode()["hold"]["stuck"]["halt_ts"] == first == h1["ts"],
      "two readers: the second keeps the first one's mismatch HALT (same file, its timestamp recorded)")
user_resume()
kind, pos = judged()
check(kind == "ok" and halt_file() is None and acct.switch_hold_left() == 0,
      "…so one 啟動下單 releases the hold (no second HALT)", (kind, halt_file()))

# ③ a leg missing: HALT at once (not after SWITCH_MAX_S)
classic_with([V2_NVDA, V2_ACN])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03")]
kind, pos = judged()
h = halt_file()
check(kind == "ok" and h
      and h["mismatch"]["legs"] == [{"symbol": "ACNUSDT", "side": "short", "before": 0.05, "now": None}],
      "③ ACN short missing after the minimum hold: HALT at once, listed under the strategy's symbol (now: none)", (kind, pos, h))
user_resume()

# ④ a leg that was not there: HALT at once
classic_with([V2_NVDA])
UPOS[:] = [upos("NVDAUSDT", "long", "0.03"), upos("BTCUSDT", "short", "0.001", mark="81000")]
kind, pos = judged()
h = halt_file()
check(kind == "ok" and h
      and h["mismatch"]["legs"] == [{"symbol": "BTCUSDT", "side": "short", "before": None, "now": 0.001}],
      "④ an extra BTC short after the switch: HALT at once (before: none)", (kind, pos, h))
user_resume()
judged()

# someone else's HALT stood when the mismatch was found: kept, ours follows its resume
classic_with([V2_NVDA])
guard.trip_halt("paused by the user", "web")
UPOS[:] = [upos("NVDAUSDT", "long", "0.02")]
kind, pos = judged()
check(kind == "ok" and halt_file()["source"] == "web" and acct.switch_hold_left() > 0,
      "a user's HALT standing at the mismatch is not overwritten (the hold stays)")
user_resume()
kind, pos = judged()
h = halt_file()
check(kind == "ok" and h and h["reason"].startswith(acct.MISMATCH_TAG) and acct.switch_hold_left() > 0,
      "…their resume brings up the mismatch HALT (the list was never shown)", (kind, h))
user_resume()
kind, pos = judged()
check(kind == "ok" and acct.switch_hold_left() == 0, "…and resuming that one releases the hold")

# ⑤ a mode file from before quantities were recorded: legs match on symbol and side
fresh_mode()
acct._write_mode({"mode": "classic", "legs": [["NVDAUSDT", "long"]],
                  "hold": {"since": _time.time(), "await": [["NVDAUSDT", "long"]], "from": "classic"}})
acct._write_mode({"mode": "classic", "legs": [["NVDAUSDT", "long"]], "hold": None})
SETTINGS["accountMode"] = "unified"
UPOS[:] = [upos("NVDAUSDT", "long", "0.05")]
try:
    acct.get_positions(ENV)
except acct.BitgetError:
    pass
kind, pos = judged()
check(kind == "ok" and halt_file() is None and acct._read_mode().get("legs") == [["NVDAUSDT", "long", 0.05]],
      "⑤ an old [symbol, side] record: matched on symbol and side (no quantity to compare), then rewritten with it",
      (kind, pos, acct._read_mode()))

# a first read or a lost record (no mode switched from) keeps the old rule: release once every recorded leg reads back
UPOS[:] = [upos("NVDAUSDT", "long", "0.03")]
st = acct._read_mode()
acct._write_mode({**st, "hold": {"since": _time.time() - acct.SWITCH_MAX_S - 1, "await": [["ACNSTOCKUSDT", "short"]]}})
try:
    acct.get_positions(ENV)
    check(False, "a hold past SWITCH_MAX_S raises")
except acct.BitgetError as e:
    check(acct.classify(e) == "unknown" and "ACNSTOCKUSDT short" in str(e) and halt_file() is None,
          "a hold with no switch behind it, past SWITCH_MAX_S with a leg missing: MODE_STUCK, no HALT of its own", str(e))
# an unreadable record holds (fail-closed), then restarts a hold of its own
with open(acct.MODE_PATH, "w") as f:
    f.write("{not json")
check(acct.switch_hold_left() == acct.SWITCH_HOLD_S and order.session_open(ENV, "NVDAUSDT") is False,
      "a corrupt mode file holds (fail-closed), never reads as 'no switch'")
acct._mode.update(mode=None, at=0.0)
try:
    acct.get_positions(ENV)
    check(False, "positions with a corrupt mode file raise")
except acct.BitgetError as e:
    check(acct.classify(e) == "transient" and acct._read_mode().get("hold"),
          "…the next read rewrites it with a fresh hold and raises TRANSIENT")
age_hold(acct.SWITCH_HOLD_S + 1)
check(acct.get_positions(ENV)[0]["symbol"] == "NVDAUSDT" and acct.switch_hold_left() == 0 and halt_file() is None,
      "…and releases past the minimum")

# a process whose mode was cached as classic meets 40085 on an ORDER: refused, never re-sent to v3
acct._mode.update(mode="classic", at=_time.time())
route("GET", "/api/v2/mix/account/account", lambda p: ok({"marginCoin": "USDT", **MODE}))
route("POST", "/api/v2/mix/order/place-order",
      lambda p: err("40085", "You are in Unified Account mode, and the Classic Account API is not supported at this time"))
n = len(UPOSTS)
try:
    order.place_market_order(ENV, "NVDAUSDT", "long", 0.03)
    check(False, "an order meeting 40085 raises")
except acct.BitgetError as e:
    check(acct.classify(e) == "transient" and len(UPOSTS) == n,
          "an order refused with 40085 raises TRANSIENT and is NOT re-sent through v3 in the same call", str(e))
check(acct._mode["mode"] == "uta", "…and the process now trades through v3")
UPOS[:] = []
SETTINGS["accountMode"] = "unified"

# ── the gate per account type: only the verified type trades ─────────────────
acct.SWITCH_HOLD_S = 0
for verified, have, other in (("uta", "__classic__", "classic"), ("classic", "unified", "uta")):
    acct.VERIFIED_MODES = frozenset({verified})
    fresh_mode()
    SETTINGS["accountMode"] = have
    n, nposts = len(UPOSTS), len(CALLS)
    for label, fn in (("account_mode", lambda: acct.account_mode(ENV)), ("equity", lambda: acct.get_equity(ENV)),
                      ("positions", lambda: acct.get_positions(ENV)),
                      ("entry", lambda: order.place_market_order(ENV, "NVDAUSDT", "long", 0.03))):
        try:
            fn()
            check(False, f"only {verified} verified: a {other} key's {label} is refused")
        except acct.BitgetError as e:
            check(e.code == acct.UNVERIFIED and acct._MODE_NAMES[other] in str(e) and acct._MODE_NAMES[verified] in str(e)
                  and f"[{acct.MODE_TAG}:{other}]" in str(e)
                  and not any(c["method"] == "POST" for c in CALLS[nposts:]),
                  f"only {verified} verified: a {other} key's {label} is refused in words, nothing posted", str(e))
    acct._mode.update(mode=other, at=acct.time.time())  # even a cached mode is re-checked
    try:
        acct.account_mode(ENV)
        check(False, "a cached unverified mode is refused")
    except acct.BitgetError as e:
        check(e.code == acct.UNVERIFIED, f"only {verified} verified: a cached {other} mode is refused too")
    path = "/api/v2/mix/order/place-order" if other == "classic" else "/api/v3/trade/place-order"
    del CALLS[:]
    try:
        order._request("POST", path, ENV, {"symbol": "NVDAUSDT", "side": "buy", "clientOid": "x"})
        check(False, "an order on the unverified API is refused")
    except acct.BitgetError as e:
        check(e.code == acct.UNVERIFIED and not CALLS,
              f"only {verified} verified: an order on the {other} API is refused before the transport")
fresh_mode()
acct.VERIFIED_MODES = frozenset({"uta"})
SETTINGS["accountMode"] = "unified"
check(acct.account_mode(ENV) == "uta" and acct.get_equity(ENV)["currency"] == "USDT",
      "only uta verified: a UTA key reads as before")
acct.VERIFIED_MODES = BOTH

print("\n" + ("all checks passed" if not fails else f"FAILED: {fails}"))
sys.exit(1 if fails else 0)
