"""
StockCoin order execution — USDT perpetual futures (crypto, US / KR stocks,
ETFs, commodities, pre-IPO), BlueHelix (BHEX) Broker OpenAPI white label.

Companion to lib/account_stockcoin.py. Credentials: STOCKCOIN_API_KEY /
STOCKCOIN_SECRET_KEY in .env. The key must be a FUTURES-type key
(account_type 3) — any other type answers -1005 NO_PERMISSION on every call.

LAYERS SHIPPED HERE: the reconciler's four fixed names, get_mark_price,
get_position_mode; the limit layer (place_limit_order / get_bbo / get_order /
cancel_order / get_open_orders); SL/TP as STOP orders (place_protective_orders /
open_position / cancel_protective_orders). Not here: spot (the venue has no
spot API).

Measured on a live key (tests/live_stockcoin_verify.py --probe-all): a
one-contract market open + close fills on 31 of the 36 listed contracts; the
other five (BTC, ETH, XRP, SAMSUNG, SKHYNIX) answer -1157 "not available for
api trading" and are refused with the symbol_unavailable token below. Which
contracts are open is the venue's call, so it is read off the reply, not a
list kept here. Not measured: STOP orders, limit / post-only.

No broker attribution: StockCoin has no broker / referral id (Wei 2026-10-14),
so no attribution field is sent.

StockCoin facts:
- symbols are {BASE}-PERP-USDT; the platform canonical is BASEUSDT
  (NVDAUSDT, BTCUSDT) — converted only inside this lib.
- size is CONTRACTS (张). The multiplier is not published by any endpoint
  (brokerInfo is closed); from public 24h volume vs turnover every listed
  symbol reads 0.0001 base per contract. get_contract_rules re-derives it from
  the public ticker and refuses the symbol when the table disagrees — a wrong
  multiplier is an N-times order.
- hedge mode only: the side carries open/close (BUY_OPEN / SELL_CLOSE = long
  leg, SELL_OPEN / BUY_CLOSE = short leg), so a reduce can never open the
  opposite leg.
- market order = orderType LIMIT + priceType MARKET + price "0".
- clientOrderId is mandatory; a reused one answers -1141 DUPLICATED_ORDER.
- signature = HMAC-SHA256 over the alphabetically sorted query string followed
  directly (no separator) by the sorted form body; POST bodies are form-data.
  Measured: a wrong secret answers -1022, a wrong key -1002.
- errors are HTTP 400 + {"code": <negative>, "msg"} — an unauthorized key is
  400 / -1002, not 401.
- limit layer, measured (live T7): post-only = timeInForce LIMIT_MAKER (the
  doc lists GTC / IOC / FOK only); a LIMIT_MAKER that would cross answers -1158
  "create limit maker order failed". No tick size is published: too many price
  decimals answers -1134 "Order price decimal too long" — the decimals are read
  off the public depth and stepped down once on -1134. A cancel's reply is the
  order as it was BEFORE the cancel (NEW), and cancelling a cancelled order
  answers that order again (CANCELED), not an error.
- STOP orders, measured (live T8): orderType STOP + triggerPrice + priceType
  MARKET + a *_CLOSE side; one under and one over the price both rest (the
  venue picks the direction), they do not lock `available`, their status words
  are ORDER_NEW / ORDER_CANCELED, they list and cancel with orderType=STOP.
"""

import hashlib
import hmac
import re
import time
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal
from urllib.parse import urlencode

import requests

from lib import guard
from lib.account_stockcoin import multiplier
try:
    from lib import reject_token
except ImportError:  # half-updated workspace (lib/reject_token.py not landed): orders work, messages go out untagged
    from types import SimpleNamespace as _NS
    reject_token = _NS(tag=lambda kind, msg: str(msg), from_code=lambda *a, **k: None, credential_codes=lambda v: frozenset(),
                       **{k: k.lower() for k in ("INSUFFICIENT_MARGIN", "BELOW_MIN_SIZE", "SYMBOL_UNAVAILABLE",
                                                 "KEY_PERMISSION", "REDUCE_ONLY_REJECTED", "PAPER_MARGIN")})

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)

LIVE_HOST = "https://api.stockcoin.ai"
PREFIX = "/openapi/v1"
ORDER_PATH = "/futures/order"

# implied 24h VWAP (turnover / (contracts × multiplier)) may sit this far
# outside the 24h low-high range before the multiplier is called wrong — a
# wrong multiplier is off by 10× or more, rounding noise is well under this
MULTIPLIER_BAND = 0.03
RULES_TTL_S = 3600

TIMESTAMP_ERROR = "-1021"
RATE_LIMITED = "-1003"
DUPLICATED_ORDER = "-1141"
# cancel of an order that is gone (filled / cancelled) or never existed
_CANCEL_GONE = {"-2013", "-1142", "-1150"}
POST_ONLY_CROSS = "-1158"
PRICE_DECIMALS = "-1134"

_time_offset = {"ms": 0}
_rules_cache = {}

_FILLED = {"FILLED"}
_GONE = {"CANCELED", "CANCELLED", "REJECTED"}
_CID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class StockcoinError(Exception):
    """code = the venue's error code (str), http_status = HTTP status —
    lib/account_stockcoin.classify reads them."""

    def __init__(self, msg, code=None, http_status=None, kind=None):
        code = None if code is None else str(code)
        kind = kind or reject_token.from_code(code, _REJECT_CODES,
                                              reject_token.credential_codes("stockcoin"))
        super().__init__(reject_token.tag(kind, msg))
        self.code = code
        self.http_status = http_status


# lib/reject_token kinds, from the venue doc §6.3 and -1157 (not in the doc,
# measured on every refused contract of the live probe). -1149
# CREATE_ORDER_FAILED ("check balance, position limits") is left unclassified
# until a live reply shows which of the two it is.
API_CLOSED = "-1157"
_REJECT_CODES = {"-1136": reject_token.BELOW_MIN_SIZE, "-1200": reject_token.BELOW_MIN_SIZE,
                 "-1121": reject_token.SYMBOL_UNAVAILABLE, API_CLOSED: reject_token.SYMBOL_UNAVAILABLE}


class OrderNotConfirmed(Exception):
    """Placed but not terminal within the timeout — it may still fill.
    Re-query by client_order_id; NEVER blindly resubmit."""


def _creds(env):
    api_key = env.get("STOCKCOIN_API_KEY")
    secret = env.get("STOCKCOIN_SECRET_KEY")
    if not api_key or not secret:
        raise ValueError("STOCKCOIN_API_KEY / STOCKCOIN_SECRET_KEY missing from .env")
    return api_key, secret


def _now_ms():
    return int(time.time() * 1000) + _time_offset["ms"]


def _sync_time(env):
    """After a -1021: offset our clock against the venue's (public
    /openapi/v1/time). A failed read keeps the old offset."""
    try:
        t0 = time.time()
        r = requests.get(f"{LIVE_HOST}{PREFIX}/time", timeout=5)
        t1 = time.time()
        _time_offset["ms"] = int(r.json()["serverTime"]) - int((t0 + t1) / 2 * 1000)
    except Exception:
        pass


def sign_request(secret, query, body=None):
    """(query string with signature appended, form body string). The strings
    signed are the strings sent, byte for byte: both sides are serialized
    here, sorted, and never re-encoded by requests."""
    qs = urlencode(sorted((k, str(v)) for k, v in query.items()))
    bs = urlencode(sorted((k, str(v)) for k, v in (body or {}).items()))
    sig = hmac.new(secret.encode(), (qs + bs).encode(), hashlib.sha256).hexdigest()
    return f"{qs}&signature={sig}", bs


# ── symbols ──────────────────────────────────────────────────────────────────

def venue_symbol(symbol):
    """Canonical BASEUSDT (or the venue's own form) → BASE-PERP-USDT."""
    s = str(symbol or "").upper().replace("-PERP-", "").replace("-", "").replace("_", "").replace("/", "")
    if not s.endswith("USDT") or len(s) <= 4:
        raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE,
                                          f"cannot derive a StockCoin contract from {symbol!r}"))
    return f"{s[:-4]}-PERP-USDT"


def canonical_symbol(vsym):
    """BASE-PERP-USDT → BASEUSDT."""
    return str(vsym or "").upper().replace("-PERP-", "").replace("-", "")


# ── transport ────────────────────────────────────────────────────────────────

def _order_intent(method, path, params):
    """'entry' | 'reduce' | 'protective' | 'cancel' | None, from the BODY's
    side: *_OPEN builds exposure, *_CLOSE reduces it. A STOP order is
    protective only when it closes; a STOP that opens is an entry."""
    if method == "DELETE" and (path == ORDER_PATH or path.startswith("/futures/cancel")):
        return "cancel"
    if method != "POST" or path != ORDER_PATH:
        return None
    side = str((params or {}).get("side", "")).upper()
    closes = side.endswith("_CLOSE")
    if str((params or {}).get("orderType", "")).upper() == "STOP":
        return "protective" if closes else "entry"
    return "reduce" if closes else "entry"


_AUDIT_KEYS = ("symbol", "side", "orderType", "priceType", "quantity", "price",
               "triggerPrice", "timeInForce", "clientOrderId")


def _request(method, path, env, params=None, retries=3):
    """Signed request with the guard gate + audit on order-mutating calls."""
    intent = _order_intent(method, path, params)
    if intent is None:
        return _send(method, path, env, params, retries)
    fields = {k: params[k] for k in _AUDIT_KEYS if k in (params or {})}
    fields["intent"] = intent
    guard.check_restart_stop(intent, fields)
    guard.check_account_hold("stockcoin", intent, fields)
    if intent == "entry" and guard.entry_blocked():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for "
            f"{fields.get('symbol')} refused before reaching the exchange. "
            f"Closes and cancels still work. Only the user may clear the halt "
            f"(guard.clear_halt)."
        )
    guard.audit("order_attempt", **fields)
    try:
        data = _send(method, path, env, params, retries)
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise
    oid = data.get("orderId") if isinstance(data, dict) else ""
    guard.audit("order_ok", order_id=str(oid or ""), **fields)
    return data


def _error_of(r):
    """(code, msg) when the reply is an error, else None. Errors are HTTP 4xx
    with {"code": <negative>}; some success replies carry {"code": 200}."""
    try:
        body = r.json()
    except ValueError:
        return (r.status_code, r.text[:160]) if r.status_code >= 400 else None
    if not isinstance(body, dict):
        return (r.status_code, r.text[:160]) if r.status_code >= 400 else None
    code, msg = body.get("code"), str(body.get("msg") or "")
    if r.status_code >= 400:
        return (code if code is not None else r.status_code), msg
    if code is not None and str(code).lstrip("-").isdigit() and int(code) < 0:
        return code, msg
    return None


def _send(method, path, env, params=None, retries=3):
    api_key, secret = _creds(env)
    method = method.upper()
    params = dict(params or {})
    last_err = None
    resynced = False
    for attempt in range(retries):
        if method == "POST":
            query, body = {"timestamp": _now_ms()}, params
        else:
            query, body = {**params, "timestamp": _now_ms()}, None
        qs, bs = sign_request(secret, query, body)
        headers = {"X-BH-APIKEY": api_key}
        if bs:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        url = f"{LIVE_HOST}{PREFIX}{path}?{qs}"
        try:
            r = requests.request(method, url, headers=headers, data=bs or None, timeout=15)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            # a POST whose reply died may have landed: never resend it — find
            # it by its clientOrderId instead (the reconciler re-reads
            # positions next round if even that cannot tell)
            if method == "POST":
                found = _lookup_cid(env, params) if path == ORDER_PATH else None
                if found:
                    return found
                raise
            last_err = e
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt)
            continue
        err = _error_of(r)
        if err is None:
            if not r.text:
                return {}
            try:
                return r.json()
            except ValueError:
                raise StockcoinError(f"stockcoin {path}: non-JSON reply ({r.text[:120]})",
                                     http_status=r.status_code)
        code, msg = str(err[0]), err[1]
        if api_key in msg:
            msg = msg.replace(api_key, "***")
        text = f"stockcoin {path} code={code}: {msg}"
        if code == API_CLOSED:
            # the reply is English and names no symbol; the notice and the
            # order_errors row (200 chars) are read by the user
            text = (f"StockCoin 不開放 {canonical_symbol(params.get('symbol'))} 用 API 下單，只能在 "
                    f"StockCoin App 手動交易；請把策略換到別的交易所，或換成 StockCoin 開放 API 的商品"
                    f"（{text}）")
        e = StockcoinError(text, code=code, http_status=r.status_code)
        if code == TIMESTAMP_ERROR and not resynced and attempt < retries - 1:
            # refused at authentication — resending cannot double anything
            resynced = True
            _sync_time(env)
            last_err = e
            continue
        retryable = code == RATE_LIMITED or (method != "POST" and r.status_code >= 500)
        if retryable and attempt < retries - 1:
            time.sleep(1 + attempt * 2)
            last_err = e
            continue
        if code == DUPLICATED_ORDER and path == ORDER_PATH and method == "POST":
            found = _lookup_cid(env, params)
            if found:
                return found
        raise e
    raise last_err


def _lookup_cid(env, params):
    """The order a clientOrderId already names, or None."""
    cid, sym = (params or {}).get("clientOrderId"), (params or {}).get("symbol")
    if not cid or not sym:
        return None
    try:
        row = _send("GET", ORDER_PATH, env, {"symbol": sym, "clientOrderId": cid}, retries=1)
    except Exception:
        return None
    return row if isinstance(row, dict) and row.get("orderId") else None


def _public(path, params=None):
    r = requests.get(f"{LIVE_HOST}{path}", params=params, timeout=10)
    err = _error_of(r)
    if err is not None:
        raise StockcoinError(f"stockcoin {path} code={err[0]}: {err[1]}", code=err[0],
                             http_status=r.status_code)
    return r.json()


def _ticker(vsym):
    rows = _public("/openapi/quote/v1/contract/ticker/24hr", {"symbol": vsym})
    row = rows[0] if isinstance(rows, list) and rows else rows
    if not isinstance(row, dict) or row.get("symbol") != vsym:
        raise StockcoinError(f"stockcoin: no ticker for {vsym}",
                             kind=reject_token.SYMBOL_UNAVAILABLE)
    return row


# ── contract rules ───────────────────────────────────────────────────────────

def _check_multiplier(vsym, mult, ticker):
    """Raise when the 24h turnover says the multiplier is wrong: turnover ÷
    (contracts × multiplier) is the 24h VWAP and must sit inside the 24h
    low-high range. A symbol with no 24h volume cannot be checked."""
    try:
        vol = Decimal(str(ticker.get("volume") or 0))
        quote = Decimal(str(ticker.get("quoteVolume") or 0))
        hi = Decimal(str(ticker.get("highPrice") or 0))
        lo = Decimal(str(ticker.get("lowPrice") or 0))
    except Exception:
        return
    if vol <= 0 or quote <= 0 or hi <= 0 or lo <= 0:
        return
    vwap = quote / (vol * mult)
    band = Decimal(str(MULTIPLIER_BAND))
    if not (lo * (1 - band) <= vwap <= hi * (1 + band)):
        raise StockcoinError(
            f"stockcoin {vsym}: contract multiplier {mult} disagrees with the market "
            f"(implied 24h VWAP {vwap:.6g} outside {lo}-{hi}) — refusing to size orders "
            f"until lib/account_stockcoin.MULTIPLIERS is corrected",
            kind=reject_token.SYMBOL_UNAVAILABLE)


def get_contract_rules(env, symbol):
    """Cross-venue contract: {'step','min_qty','min_notional','contract_value'}
    with min_qty in BASE units and step in CONTRACTS — use format_qty, never
    convert by hand. Public data only (the reconciler calls this every round)."""
    vsym = venue_symbol(symbol)
    hit = _rules_cache.get(vsym)
    if hit and time.time() - hit[0] < RULES_TTL_S:
        return hit[1]
    mult = multiplier(vsym)
    _check_multiplier(vsym, mult, _ticker(vsym))
    rules = {
        "step": "1",
        "min_qty": float(mult),        # one contract (filled live)
        "min_notional": 0.0,
        "contract_value": float(mult),
    }
    _rules_cache[vsym] = (time.time(), rules)
    return rules


def _to_contracts(qty, mult):
    """BASE qty → whole contracts, floored. A qty that is a whole number of
    contracts up to float noise (0.0060999999999999995 for 61 contracts) counts
    as that number — flooring it would drop a contract."""
    c = Decimal(str(abs(float(qty)))) / mult
    n = c.to_integral_value(rounding=ROUND_HALF_UP)
    if abs(c - n) <= Decimal("1e-6"):
        return int(n)
    return int(c.to_integral_value(rounding=ROUND_DOWN))


def format_qty(env, symbol, qty, price=None):
    """BASE qty → CONTRACTS string. Raises ValueError below one contract.
    MIN-SIZE GATE ONLY — never feed the return into place_market_order (it
    would be read as base units and the order would be 10,000× too big)."""
    rules = get_contract_rules(env, symbol)
    n = _to_contracts(qty, Decimal(str(rules["contract_value"])))
    if n < 1:
        raise ValueError(reject_token.tag(reject_token.BELOW_MIN_SIZE,
                                          f"{symbol} qty {qty} is {n} contracts, below 1"))
    return str(n)


# ── positions ────────────────────────────────────────────────────────────────

def get_position_mode(env):
    """Always 'hedge' — StockCoin has no one-way mode (the side names the leg)."""
    return "hedge"


def _available(env, vsym, direction):
    """Contracts of that leg not locked by open orders (positions.available)."""
    rows = _request("GET", "/futures/positions", env,
                    {"symbol": vsym, "side": "LONG" if direction == "long" else "SHORT"})
    want = "LONG" if direction == "long" else "SHORT"
    total = Decimal(0)
    for p in rows or []:
        if p.get("symbol") == vsym and str(p.get("side", "")).upper() == want:
            total += abs(Decimal(str(p.get("available") or 0)))
    return int(total)


def get_mark_price(env, symbol):
    """Last trade price off the public ticker — the venue publishes no mark
    price. Used for USD→qty conversion and execute._venue_min_slice_usd."""
    px = float(_ticker(venue_symbol(symbol)).get("lastPrice") or 0)
    if px <= 0:
        raise StockcoinError(f"stockcoin {symbol}: ticker has no last price")
    return px


# ── orders ───────────────────────────────────────────────────────────────────

def _side(direction, reduce_only):
    if reduce_only:
        return "SELL_CLOSE" if direction == "long" else "BUY_CLOSE"
    return "BUY_OPEN" if direction == "long" else "SELL_OPEN"


def _cid(client_order_id=None):
    if not client_order_id:
        return "rc" + time.strftime("%y%m%d%H%M%S", time.gmtime()) + f"{int(time.time() * 1e6) % 1000000:06d}"
    cid = str(client_order_id)
    if not _CID_RE.match(cid):
        raise ValueError(f"client_order_id {cid[:40]!r} has characters StockCoin may not accept")
    return cid


def _norm(symbol, o, mult):
    if not isinstance(o, dict) or "status" not in o:
        raise StockcoinError(f"stockcoin {symbol}: order reply has no status ({str(o)[:160]})")
    raw = str(o.get("status") or "").upper()
    executed = Decimal(str(o.get("executedQty") or o.get("executeQty") or 0))
    if raw in _FILLED:
        status = "filled"
    elif raw in _GONE:
        # a market order's unfilled rest is cancelled: terminal, maybe not empty
        status = "filled" if executed > 0 else "canceled"
    else:
        status = "open"
    reply_mult = o.get("contractMultiplier")
    if reply_mult not in (None, "") and Decimal(str(reply_mult)) != mult:
        raise StockcoinError(
            f"stockcoin {symbol}: order {o.get('orderId')} reports contractMultiplier "
            f"{reply_mult}, this lib sized with {mult} — fix "
            f"account_stockcoin.MULTIPLIERS before any further order")
    avg = o.get("avgPrice")
    return {
        "order_id": str(o.get("orderId") or ""),
        "client_order_id": o.get("clientOrderId") or "",
        "status": status,
        "raw_status": raw,
        "avg_price": float(avg) if avg not in (None, "") else 0.0,
        "executed_qty": float(executed * mult),
        "orig_qty": float(Decimal(str(o.get("origQty") or 0)) * mult),
        "reduce_only": bool(o.get("isClose")),
    }


def _commission(env, vsym, order_id, since_ms, attempts=3):
    """Fees live on the trade rows, not the order. They may land after the
    order reads FILLED (the live probe's HYUNDAI close found none on its one
    read), so a miss is re-read briefly. Best-effort: None when they still
    cannot be read (never a made-up 0)."""
    for i in range(attempts):
        if i:
            time.sleep(0.5 * i)
        try:
            rows = _request("GET", "/futures/trades", env,
                            {"symbol": vsym, "startTime": since_ms, "limit": 500})
        except Exception:
            continue
        fees = [abs(float(t.get("fee") or 0)) for t in rows or []
                if str(t.get("orderId")) == str(order_id)]
        if fees:
            return sum(fees)
    return None


def get_order(env, symbol, order_id=None, client_order_id=None):
    """One order, normalized: {'order_id','status' (open|filled|canceled),
    'avg_price','executed_qty','orig_qty'} with quantities in BASE units."""
    vsym = venue_symbol(symbol)
    q = {"symbol": vsym}
    if order_id:
        q["orderId"] = order_id
    elif client_order_id:
        q["clientOrderId"] = client_order_id
    else:
        raise ValueError("get_order needs order_id or client_order_id")
    mult = Decimal(str(get_contract_rules(env, symbol)["contract_value"]))
    return _norm(symbol, _request("GET", "/futures/order", env, q), mult)


def _confirm(env, symbol, order_id, timeout=20):
    deadline = time.time() + timeout
    delay = 0.4
    o = None
    while time.time() < deadline:
        o = get_order(env, symbol, order_id)
        if o["status"] != "open":
            return o
        time.sleep(delay)
        delay = min(delay * 1.6, 2.0)
    raise OrderNotConfirmed(
        f"stockcoin {symbol} order {order_id} still {o and o['raw_status']} after {timeout}s "
        f"— re-query by client_order_id, do NOT resubmit")


def place_market_order(env, symbol, direction, qty, client_order_id=None,
                       reduce_only=False):
    """Confirmed market order. qty is BASE units (converted to contracts
    here). direction is the position's direction ('long'|'short'); with
    reduce_only, the leg being closed — capped at that leg's available
    contracts. Below one contract (or nothing to close) → False. Returns
    {'avg_price','executed_qty','commission','order_id'} as the venue reports."""
    guard.arm_restore(symbol, direction, qty, reduce_only)  # HALT's one netted-restore pass
    if direction not in ("long", "short"):
        raise ValueError(f"direction must be 'long' or 'short', got {direction!r}")
    vsym = venue_symbol(symbol)
    rules = get_contract_rules(env, symbol)
    mult = Decimal(str(rules["contract_value"]))
    n = _to_contracts(qty, mult)
    if reduce_only and n >= 1:
        n = min(n, _available(env, vsym, direction))
    if n < 1:
        return False
    params = {
        "symbol": vsym,
        "side": _side(direction, reduce_only),
        "orderType": "LIMIT",
        "priceType": "MARKET",
        "price": "0",
        "quantity": str(n),
        "clientOrderId": _cid(client_order_id),
    }
    started = _now_ms() - 5000
    placed = _request("POST", "/futures/order", env, params)
    oid = (placed or {}).get("orderId")
    if not oid:
        raise StockcoinError(f"stockcoin {vsym}: order reply has no orderId ({str(placed)[:160]})")
    o = _confirm(env, symbol, oid)
    if o["status"] != "filled":
        raise StockcoinError(f"stockcoin {vsym} market order {oid} ended {o['raw_status']} "
                             f"with nothing filled")
    return {
        "avg_price": o["avg_price"],
        "executed_qty": o["executed_qty"],
        "commission": _commission(env, vsym, oid, started),
        "order_id": o["order_id"],
    }


def close_position_partial(env, symbol, direction, qty, client_order_id=None):
    """Reduce the `direction` leg by a BASE qty. Under HALT only as the
    user's explicit close (lib.guard halt close pass)."""
    return place_market_order(env, symbol, direction, qty,
                              client_order_id=client_order_id, reduce_only=True)


def cancel_order(env, symbol, order_id=None, client_order_id=None):
    """Cancel one LIMIT order. The reply is the order as it stood before the
    cancel, so only a terminal status in it is 'canceled' / 'order_finished';
    anything else is 'cancel_accepted' and the caller confirms with get_order.
    Unknown → 'order_not_found', never an exception."""
    q = {"symbol": venue_symbol(symbol)}
    if order_id:
        q["orderId"] = order_id
    elif client_order_id:
        q["clientOrderId"] = client_order_id
    else:
        raise ValueError("cancel_order needs order_id or client_order_id")
    try:
        res = _request("DELETE", "/futures/order", env, q)
    except StockcoinError as e:
        if e.code in _CANCEL_GONE:
            return {"status": "order_not_found", "order_id": order_id}
        raise
    raw = str((res or {}).get("status") or "").upper()
    status = ("canceled" if raw in _GONE else "order_finished" if raw in _FILLED
              else "cancel_accepted")
    return {"status": status, "order_id": str((res or {}).get("orderId") or order_id)}


def cancel_algo_order(env, symbol, order_id):
    """Cancel one STOP order (its own list: orderType=STOP)."""
    try:
        res = _request("DELETE", "/futures/order", env,
                       {"symbol": venue_symbol(symbol), "orderId": order_id, "orderType": "STOP"})
    except StockcoinError as e:
        if e.code in _CANCEL_GONE:
            return {"status": "order_not_found", "order_id": str(order_id)}
        raise
    # like cancel_order: the reply is the order before the cancel (ORDER_NEW)
    raw = str((res or {}).get("status") or "").upper()
    return {"status": "canceled" if raw == "ORDER_CANCELED" else "cancel_accepted",
            "order_id": str(order_id)}


def cancel_protective_orders(env, symbol):
    """Cancel every STOP order on the symbol. Returns the cancel results."""
    return [cancel_algo_order(env, symbol, o["order_id"])
            for o in get_open_algo_orders(env, symbol)]


def cancel_all_orders(env, symbol):
    """Cancel every LIMIT and STOP order on the symbol (close_symbol: only
    when the position is being closed too)."""
    return {"orders": [cancel_order(env, symbol, order_id=o["order_id"])
                       for o in get_open_orders(env, symbol)],
            "algo_orders": cancel_protective_orders(env, symbol)}


# ── limit layer ──────────────────────────────────────────────────────────────

_PRICE_DECIMALS_TTL_S = 3600
_price_decimals = {}


def _decimals_of(px):
    s = str(px)
    return len(s.split(".", 1)[1].rstrip("0")) if "." in s else 0


def _book(vsym):
    rows = _public("/openapi/quote/v1/contract/depth", {"symbol": vsym, "limit": 20})
    bids, asks = (rows or {}).get("bids") or [], (rows or {}).get("asks") or []
    if not bids or not asks:
        raise StockcoinError(f"stockcoin {vsym}: empty depth ({str(rows)[:120]})")
    return bids, asks


def _decimals(vsym):
    """Price decimals the venue accepts: the most any of 40 book levels uses
    (no endpoint publishes a tick). Cached; _place_limit steps it down on -1134."""
    hit = _price_decimals.get(vsym)
    if hit and time.time() - hit[0] < _PRICE_DECIMALS_TTL_S:
        return hit[1]
    bids, asks = _book(vsym)
    n = max(_decimals_of(r[0]) for r in bids + asks)
    _price_decimals[vsym] = (time.time(), n)
    return n


def format_price(env, symbol, price, side="BUY"):
    """Price string at the venue's decimals. Buys round down and sells up, so
    a passive price never rounds into the book."""
    q = Decimal(1).scaleb(-_decimals(venue_symbol(symbol)))
    rounding = ROUND_DOWN if str(side).upper().startswith("BUY") else ROUND_UP
    out = Decimal(str(price)).quantize(q, rounding=rounding)
    if out <= 0:
        raise ValueError(f"{symbol}: price {price} formats to {out}")
    return format(out, "f")


def get_bbo(env, symbol):
    """Top of the real book {'bid', 'ask'} off the public depth — never last."""
    bids, asks = _book(venue_symbol(symbol))
    return {"bid": max(float(r[0]) for r in bids), "ask": min(float(r[0]) for r in asks)}


def place_limit_order(env, symbol, direction, qty, price, client_order_id=None,
                      reduce_only=False, time_in_force="GTC", post_only=False):
    """Limit order, UNCONFIRMED (it may rest): the venue's order row plus
    order_id. qty is BASE units; direction is the position's ('long'|'short'),
    with reduce_only the leg being closed (capped at its available contracts).
    post_only=True → timeInForce LIMIT_MAKER; one that would cross returns
    {'status': 'post_only_rejected'}. Below one contract → False."""
    if direction not in ("long", "short"):
        raise ValueError(f"direction must be 'long' or 'short', got {direction!r}")
    vsym = venue_symbol(symbol)
    mult = Decimal(str(get_contract_rules(env, symbol)["contract_value"]))
    n = _to_contracts(qty, mult)
    if reduce_only and n >= 1:
        n = min(n, _available(env, vsym, direction))
    if n < 1:
        return False
    side = _side(direction, reduce_only)
    params = {
        "symbol": vsym, "side": side, "orderType": "LIMIT", "priceType": "INPUT",
        "price": format_price(env, symbol, price, side), "quantity": str(n),
        "timeInForce": "LIMIT_MAKER" if post_only else time_in_force,
        "clientOrderId": _cid(client_order_id),
    }
    for attempt in range(2):
        try:
            placed = _request("POST", "/futures/order", env, params)
            break
        except StockcoinError as e:
            if post_only and e.code == POST_ONLY_CROSS:
                return {"status": "post_only_rejected"}
            if e.code != PRICE_DECIMALS or attempt:
                raise
            # refused at validation, nothing rests: one decimal fewer, once
            d = max(_decimals(vsym) - 1, 0)
            _price_decimals[vsym] = (time.time(), d)
            params["price"] = format_price(env, symbol, price, side)
    if not (placed or {}).get("orderId"):
        raise StockcoinError(f"stockcoin {vsym}: limit order reply has no orderId ({str(placed)[:160]})")
    return {**placed, "order_id": str(placed["orderId"])}


# ── protective orders (STOP) ─────────────────────────────────────────────────

class ProtectionFailed(Exception):
    """The position is OPEN but a stop-loss / take-profit could not be placed
    or verified — it may be NAKED. Alert the user."""


def place_protective_orders(env, symbol, direction, qty=None, sl_price=None,
                            tp_price=None, verify=True, _after_entry=False):
    """Stop-loss / take-profit for an EXISTING position: one STOP order each,
    *_CLOSE side, market execution at the trigger. qty=None = the leg's
    contracts NOW (the venue has no close-the-whole-position flag, so a later
    size change does not follow — re-place after one). Verified in the open
    STOP list; raises ProtectionFailed otherwise. Returns {'sl'|'tp':
    {'algoId', 'raw'}}; cancel with cancel_algo_order / cancel_protective_orders."""
    vsym = venue_symbol(symbol)
    placed = {}
    try:
        if qty is None:
            n = _available(env, vsym, direction)
        else:
            n = _to_contracts(qty, Decimal(str(get_contract_rules(env, symbol)["contract_value"])))
        if n < 1:
            raise StockcoinError(f"stockcoin {vsym}: no {direction} contracts to protect")
        side = _side(direction, True)
        for kind, trigger in (("sl", sl_price), ("tp", tp_price)):
            if trigger is None:
                continue
            o = _request("POST", "/futures/order", env, {
                "symbol": vsym, "side": side, "orderType": "STOP", "priceType": "MARKET",
                "price": "0", "triggerPrice": format_price(env, symbol, trigger, side),
                "quantity": str(n), "clientOrderId": _cid()})
            if not (o or {}).get("orderId"):
                raise StockcoinError(f"stockcoin {vsym}: {kind} reply has no orderId ({str(o)[:160]})")
            placed[kind] = {"algoId": str(o["orderId"]), "raw": o}
    except guard.Halted as e:
        wanted = [k for k, p in (("sl", sl_price), ("tp", tp_price)) if p is not None]
        raise ProtectionFailed(
            guard.protection_halted_text(symbol, direction, wanted, placed, _after_entry) + f" {e}") from e
    except Exception as e:
        raise ProtectionFailed(f"{symbol} {direction} position may be NAKED — placing protective "
                               f"orders failed after {list(placed)} succeeded: {e}") from e
    if verify and placed:
        open_ids = {o["order_id"] for o in get_open_algo_orders(env, symbol)}
        missing = [k for k, o in placed.items() if o["algoId"] not in open_ids]
        if missing:
            raise ProtectionFailed(f"{symbol} {direction}: protective order(s) {missing} accepted "
                                   f"but NOT in the open STOP list — position may be naked")
    return placed


def open_position(env, symbol, direction, qty, sl_price=None, tp_price=None,
                  client_order_id=None):
    """Confirmed market entry, then its stop-loss / take-profit (two steps: a
    naked window of one round trip; ProtectionFailed if they don't verify)."""
    entry = place_market_order(env, symbol, direction, qty, client_order_id=client_order_id)
    if entry is False:
        return False
    protection = {}
    if sl_price is not None or tp_price is not None:
        protection = place_protective_orders(env, symbol, direction, sl_price=sl_price,
                                             tp_price=tp_price, _after_entry=True)
    return {"entry": entry, "protection": protection}


def _open_rows(env, symbol, order_type):
    q = {"orderType": order_type, "limit": 500}
    if symbol:
        q["symbol"] = venue_symbol(symbol)
    return _request("GET", "/futures/orders/open", env, q) or []


def get_open_orders(env, symbol=None):
    """Open LIMIT orders (orphan sweep, close_symbol). STOP orders are a
    separate list on this venue — see get_open_algo_orders."""
    return [{
        "order_id": str(o.get("orderId") or ""),
        "client_order_id": o.get("clientOrderId") or "",
        "symbol": canonical_symbol(o.get("symbol")),
        "side": o.get("side"),
        "type": o.get("orderType"),
        "price": float(o.get("price") or 0),
        "reduce_only": bool(o.get("isClose")),
    } for o in _open_rows(env, symbol, "LIMIT")]


def get_open_algo_orders(env, symbol=None):
    """Open STOP (conditional) orders: this lib's stop-loss / take-profit and
    any the user placed."""
    return [{
        "order_id": str(o.get("orderId") or ""),
        "symbol": canonical_symbol(o.get("symbol")),
        "side": o.get("side"),
        "stop_order_type": "STOP",
        "trigger_price": float(o.get("triggerPrice") or 0),
    } for o in _open_rows(env, symbol, "STOP")]
