"""
BingX swap (USDT-M perpetual) order execution library.

Companion to lib/account_bingx.py (equity/positions). Credentials:
BINGX_API_KEY, BINGX_SECRET_KEY in .env. Set BINGX_DEMO=true to trade on the
VST paper environment (open-api-vst.bingx.com — swap only) with the same keys.
X-SOURCE-KEY: BX-AI-SKILL broker attribution is mandatory on every request.

Design rules (why this file exists — hand-rolled per-machine versions of this
layer caused naked positions, duplicate orders, and TP-reported-as-SL bugs):

1. FAIL LOUD. Every unexpected response shape raises BingXError with the code
   and message. Never .get() a critical field into a silent default.
2. CONFIRMED, NOT SENT. The place-order response contains no fill info.
   `place_market_order` / `open_position` poll the order until it reaches a
   terminal state and return what the EXCHANGE says (avgPrice, executedQty,
   commission) — report those numbers, never the intent.
3. NO NAKED POSITIONS. `open_position` attaches stopLoss/takeProfit to the
   entry order itself (single atomic request — the naked window between entry
   and protective orders does not exist). Standalone protective orders are
   verified to exist on the exchange before returning.
4. NEVER SENT TWICE. An order POST that may have reached BingX (a dropped
   connection, a read timeout, a 5xx, 100500…) is not resent — not to the
   fallback domain, not under the same id — and raises OrderNotConfirmed
   carrying the client order id; the order is then looked up by that id
   (resolve_unknown_order, lib/unconfirmed). BingX refuses a reused id with
   101481, but whether that holds after the order is filled is unverified, so
   nothing here relies on it: only a query settles what happened.
5. HALTABLE + AUDITED. Every order-mutating request passes through lib/guard:
   if state/HALT exists, every order raises guard.Halted BEFORE any network
   call (cancels still pass; closes only inside the user's explicit close),
   and every attempt/outcome/denial is appended to state/audit.jsonl. See
   lib/guard.py for semantics.

Verified against ccxt's production parser + BingX official docs + two
fleet-debugged implementations. Known quirks handled here so callers never
meet them: response nested under data.order; clientOrderID (order POST) vs
clientOrderId (order query and its response); fills under data.fill_orders with startTs/
endTs and ISO-string filledTime; position mode as string "true"/"false";
orderId as huge integer (kept as str); commission returned negative.
"""

import hashlib
import hmac
import json
import os
import time
from decimal import Decimal, ROUND_DOWN

import requests

from lib import guard
try:
    from lib import reject_token
except ImportError:  # half-updated workspace (lib/reject_token.py not landed): orders work, messages go out untagged
    from types import SimpleNamespace as _NS
    reject_token = _NS(tag=lambda kind, msg: str(msg), from_code=lambda *a, **k: None, credential_codes=lambda v: frozenset(),
                       **{k: k.lower() for k in ("INSUFFICIENT_MARGIN", "BELOW_MIN_SIZE", "SYMBOL_UNAVAILABLE",
                                                 "KEY_PERMISSION", "REDUCE_ONLY_REJECTED", "PAPER_MARGIN")})

try:
    from lib import stock_perps
except ImportError:  # half-updated workspace: plain symbol mapping, as before
    stock_perps = None

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)

LIVE_URL = "https://open-api.bingx.com"
LIVE_FALLBACK = "https://open-api.bingx.pro"
DEMO_URL = "https://open-api-vst.bingx.com"  # VST paper trading, swap only

RETRYABLE_CODES = {100410, 100500}  # 100410 = rate limited (no Retry-After; backoff), 100500 = internal
# An order POST answered with one of these may have executed, so it is not resent
# (_send no_resend) — official error-code reference: 100500 "System busy", 109500
# "Internal server error", 110500 "Order system busy", 109701 "Network request exception";
# 101481 / 109201 (client id already used / submitted twice) mean an order under this id
# exists. HTTP 5xx too (504: "further confirmation required").
SEND_UNKNOWN_CODES = {100500, 109500, 110500, 109701, 101481, 109201}
RECV_WINDOW = "5000"

# Limit-layer error codes, from the official error-code reference
# (github.com/BingX-API/api-ai-skills references/error-codes.md):
# 101215 = "Post Only order was cancelled because it would have been filled
# immediately" (futures; no spot twin is documented — spot detection falls back
# to message matching). 109421 = swap order does not exist (filled / cancelled /
# wrong id); 80016/80017 = older order-not-found codes ccxt still maps in
# production; 100404 = spot order does not exist (filled or cancelled).
POST_ONLY_REJECT_CODES = {101215}
SWAP_ORDER_GONE_CODES = {80016, 80017, 109421}
SPOT_ORDER_GONE_CODES = {100404}

_rules_cache = {}  # symbol -> contract rules (per-process)
_position_mode_cache = {}  # api_key -> "hedge" | "oneway"


class BingXError(Exception):
    """Raised on any BingX error response or unexpected shape."""

    def __init__(self, code, msg, path="", kind=None):
        self.code = code
        self.msg = msg
        # lib/reject_token: only rejected keys (account_bingx._CREDENTIAL) — BingX's margin and
        # reduce-only codes could not be verified from its docs, so they stay unclassified
        kind = kind or reject_token.from_code(code, {}, reject_token.credential_codes("bingx"))
        super().__init__(reject_token.tag(kind, f"BingX error {code}: {msg or '(empty msg)'} | {path}"))


class _SendUnknown(Exception):
    """An order POST whose outcome is unknown (see SEND_UNKNOWN_CODES); _request turns
    it into OrderNotConfirmed carrying the client order id."""


try:
    from lib.unconfirmed import OrderOutcomeUnknown as _OutcomeUnknown
except ImportError:  # half-updated workspace: not parkable, reported as an order failure
    class _OutcomeUnknown(Exception):
        def __init__(self, msg, venue=None, venue_symbol=None, order_id=None, client_order_id=None):
            super().__init__(msg)
            self.venue, self.venue_symbol, self.order_id = venue, venue_symbol, order_id
            self.client_order_id = client_order_id

        def parkable(self):
            return False


class OrderNotConfirmed(_OutcomeUnknown):
    """The order may have been accepted and its outcome is not known: the POST got no
    usable answer, or it did not reach a terminal state within timeout. It MAY HAVE
    FILLED — query it, never resubmit. Swap orders carry venue / venue_symbol and
    order_id or client_order_id so lib/portfolio.reconcile can park it."""


class ProtectionFailed(Exception):
    """Position is OPEN but a protective (SL/TP) order could not be placed or
    verified. The position is NAKED — alert the user immediately."""


# ── transport ────────────────────────────────────────────────────────────────

def _bases(env):
    if str(env.get("BINGX_DEMO", os.environ.get("BINGX_DEMO", ""))).lower() == "true":
        return [DEMO_URL]
    return [LIVE_URL, LIVE_FALLBACK]


TIMESTAMP_ERROR = 100421  # timestamp / recvWindow rejected
_time_offset = {"ms": 0}  # BingX's clock − ours, set by _sync_time


def _sync_time(env):
    """After a 100421: offset against BingX's own clock (server/time, public),
    best-effort — a failed read keeps the old offset and the retry still goes out."""
    try:
        t0 = time.time()
        r = requests.get(f"{_bases(env)[0]}/openApi/swap/v2/server/time",
                         headers={"X-SOURCE-KEY": "BX-AI-SKILL"}, timeout=5)
        t1 = time.time()
        server_ms = int(r.json()["data"]["serverTime"])
        _time_offset["ms"] = server_ms - int((t0 + t1) / 2 * 1000)
    except Exception:
        pass


def _sign(secret_key, params):
    params = dict(params)
    params["timestamp"] = str(int(time.time() * 1000) + _time_offset["ms"])
    params.setdefault("recvWindow", RECV_WINDOW)
    canonical = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    sig = hmac.new(secret_key.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return canonical + f"&signature={sig}"


# Order-mutating endpoints and how to classify their intent for the guard.
_MUTATING_PATHS = {
    ("POST", "/openApi/swap/v2/trade/order"): "place",
    ("DELETE", "/openApi/swap/v2/trade/order"): "cancel",
    ("DELETE", "/openApi/swap/v2/trade/allOpenOrders"): "cancel_all",
    ("POST", "/openApi/swap/v2/trade/leverage"): "leverage",
    ("POST", "/openApi/spot/v1/trade/order"): "place",
    ("POST", "/openApi/spot/v1/trade/cancel"): "cancel",
    ("POST", "/openApi/spot/v1/trade/cancelOpenOrders"): "cancel_all",
}

_PROTECTIVE_TYPES = {"STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT"}

# Params worth keeping in the audit line (no secrets live in params — the
# signature and timestamp are added later, inside _sign's own copy).
_AUDIT_PARAM_KEYS = ("symbol", "side", "positionSide", "type", "quantity",
                     "quoteOrderQty", "price", "stopPrice", "clientOrderID",
                     "newClientOrderId", "reduceOnly", "closePosition",
                     "leverage", "orderId")


def _order_intent(method, path, params):
    """'entry' | 'reduce' | 'protective' | 'cancel' | 'cancel_all' |
    'leverage' | None (not order-mutating). Hedge mode has no reduceOnly
    flag — there, closing = side opposite to positionSide.

    A conditional TYPE alone does not make an order protective (audited
    2026-08-04): a STOP_MARKET BUY with no reduce semantics is a breakout
    ENTRY, and classifying it protective would let it sail through HALT.
    Every legitimate protective order this lib produces carries reduce
    semantics (closePosition / reduceOnly / hedge opposite-side), so require
    them — conditional without reduce semantics is an entry and gets halted."""
    kind = _MUTATING_PATHS.get((method, path))
    if kind != "place":
        return kind
    p = params or {}
    if path == "/openApi/spot/v1/trade/order":
        # spot has no positions: BUY builds exposure (halt blocks it), SELL
        # liquidates inventory (same rule as reduce-only)
        return "reduce" if p.get("side") == "SELL" else "entry"
    is_reduce = (str(p.get("reduceOnly", "")).lower() == "true" or
                 str(p.get("closePosition", "")).lower() == "true")
    ps, side = p.get("positionSide"), p.get("side")
    if (ps == "LONG" and side == "SELL") or (ps == "SHORT" and side == "BUY"):
        is_reduce = True
    if p.get("type") in _PROTECTIVE_TYPES:
        return "protective" if is_reduce else "entry"
    return "reduce" if is_reduce else "entry"


def _request(method, path, env, params=None, signed=True, retries=3):
    """Gate + audit wrapper around _send. Reads pass straight through;
    order-mutating requests are halt-checked and audited (design rule 5)."""
    intent = _order_intent(method, path, params)
    if intent is None:
        return _send(method, path, env, params, signed, retries)

    fields = {k: params[k] for k in _AUDIT_PARAM_KEYS if k in (params or {})}
    fields["intent"] = intent
    guard.check_restart_stop(intent, fields)
    guard.check_account_hold("bingx", intent, fields)
    fields["demo"] = _bases(env) == [DEMO_URL]

    if intent == "entry" and guard.entry_blocked():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for "
            f"{fields.get('symbol')} refused before reaching the exchange. "
            f"Trading is paused: only cancels go out (closes on the user's explicit "
            f"close only). Only the user may clear the halt (guard.clear_halt)."
        )

    guard.audit("order_attempt", **fields)
    # swap only: spot order POSTs keep the old transport (second batch)
    placing = (method, path) == ("POST", "/openApi/swap/v2/trade/order")
    try:
        data = _send(method, path, env, params, signed, retries, no_resend=placing)
    except _SendUnknown as e:
        cid = (params or {}).get("clientOrderID")
        guard.audit("order_unknown", error=str(e), client_order_id=cid, **fields)
        raise OrderNotConfirmed(
            f"order {cid} sent, no answer ({e}) — it may have filled; check the position, "
            f"do not resubmit", venue="bingx", venue_symbol=(params or {}).get("symbol"),
            client_order_id=cid) from e
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise
    order = (data or {}).get("order", {}) if isinstance(data, dict) else {}
    guard.audit("order_ok", order_id=str(order.get("orderId", "")), **fields)
    return data


def _send(method, path, env, params=None, signed=True, retries=3, no_resend=False):
    """no_resend (swap order POSTs): once the request may have reached BingX it is never
    sent again — not to the fallback domain, not on a later attempt. A dropped connection,
    a read timeout, a body cut mid-transfer, a 5xx, a 2xx that is not JSON or a
    SEND_UNKNOWN_CODES answer raises _SendUnknown. Only a connect timeout (nothing sent:
    the fallback domain is tried), 100410 (rate limited) and 100421 (refused at
    authentication, re-signed) go out again — none of them can have executed."""
    api_key = env.get("BINGX_API_KEY")
    secret_key = env.get("BINGX_SECRET_KEY")
    if signed and (not api_key or not secret_key):
        raise ValueError("BINGX_API_KEY / BINGX_SECRET_KEY missing from .env")

    headers = {"X-SOURCE-KEY": "BX-AI-SKILL"}
    if signed:
        headers["X-BX-APIKEY"] = api_key

    last_err = None
    resynced = False
    for attempt in range(retries):
        for base in _bases(env):
            if signed:
                qs = _sign(secret_key, params or {})
            else:
                qs = "&".join(f"{k}={v}" for k, v in (params or {}).items())
            url = f"{base}{path}" + (f"?{qs}" if method != "POST" and qs else "")
            try:
                if method == "POST":
                    r = requests.post(
                        url, data=qs,
                        headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
                        timeout=10,
                    )
                else:
                    r = requests.request(method, url, headers=headers, timeout=10)
            except requests.exceptions.ConnectTimeout as e:
                last_err = e  # no connection was made: nothing reached BingX
                continue  # next base
            except (requests.exceptions.InvalidURL, requests.exceptions.MissingSchema,
                    requests.exceptions.InvalidSchema, requests.exceptions.InvalidHeader):
                raise  # refused before anything was sent
            except requests.exceptions.RequestException as e:
                # ReadTimeout / ChunkedEncodingError / ContentDecodingError are not
                # ConnectionError subclasses — after the connection was made any of them may
                # follow an order BingX took
                if no_resend:
                    raise _SendUnknown(f"{type(e).__name__}: {str(e)[:120]}") from e
                if not isinstance(e, requests.exceptions.ConnectionError) \
                        or isinstance(e, requests.exceptions.Timeout):
                    raise
                last_err = e
                continue  # next base
            if no_resend and r.status_code >= 500:
                raise _SendUnknown(f"HTTP {r.status_code}: {r.text[:120]}")
            try:
                data = r.json()
            except ValueError:
                if no_resend and 200 <= r.status_code < 300:
                    raise _SendUnknown(f"HTTP {r.status_code} non-JSON ({r.text[:80]})")
                if no_resend:
                    raise BingXError(r.status_code, f"non-JSON response ({r.text[:120]})", path)
                raise
            code = data.get("code")
            if code == 0:
                return data.get("data")
            if no_resend and code in SEND_UNKNOWN_CODES:
                raise _SendUnknown(f"{code}: {data.get('msg')}")
            if code in RETRYABLE_CODES and attempt < retries - 1:
                last_err = BingXError(code, data.get("msg"), path)
                time.sleep(1 + attempt)
                break  # retry outer loop from primary base
            if code == TIMESTAMP_ERROR and signed and not resynced and attempt < retries - 1:
                # refused at authentication — resending cannot double anything
                resynced = True
                _sync_time(env)
                last_err = BingXError(code, data.get("msg"), path)
                break
            raise BingXError(code, data.get("msg"), path)
        else:
            # every base failed to connect
            if attempt == retries - 1:
                raise last_err
            time.sleep(1 + attempt)
    raise last_err


# ── contract rules / quantity formatting ────────────────────────────────────

def _bingx_symbol(sym):
    """Canonical dashless symbols (BTCUSDT — what strategies/reconciler use)
    → BingX swap format (BTC-USDT). Already-dashed symbols pass through."""
    import re as _re
    if "-" not in sym:
        return _re.sub(r"^([A-Z0-9]+?)(USDT|USDC)$", r"\1-\2", sym.upper())
    return sym


_CONTRACTS_TTL_S = 600
_contracts = {"rows": None, "at": 0.0}  # the whole /quote/contracts list; status changes intraday
_PAUSED = 25  # measured 2026-10-19: status 25 rows answer 109415 "…is pause currently"


def _contract_rows(env):
    now = time.time()
    if not _contracts["rows"] or now - _contracts["at"] > _CONTRACTS_TTL_S:
        rows = _request("GET", "/openApi/swap/v2/quote/contracts", env, signed=False) or []
        if not rows:  # never cached: an empty list reads every stock position as flat
            raise BingXError("N/A", "empty /quote/contracts list", "contracts")
        _contracts.update(rows=rows, at=now)
    return _contracts["rows"]


def _swap_symbol(env, sym):
    """_bingx_symbol, except a Binance US stock perp goes to BingX's own NCSK… name
    (lib/stock_perps); one with no BingX listing raises symbol_unavailable."""
    if "-" in sym or stock_perps is None or stock_perps.binance_class(sym.upper()) != stock_perps.STOCK:
        return _bingx_symbol(sym)  # a coin never reads the contract list here
    return stock_perps.venue_name("bingx", sym.upper(), _contract_rows(env)) or _bingx_symbol(sym)


def _canonical_symbol(env, venue_sym):
    """BingX's swap name → the strategy's (NCSKNVDA2USD-USDT → NVDAUSDT, BTC-USDT → BTCUSDT)."""
    plain = str(venue_sym or "").replace("-", "").upper()
    if stock_perps is None or not plain.startswith("NC"):
        return plain
    return stock_perps.canonical("bingx", plain, _contract_rows(env))


def session_open(env, symbol):
    """False while BingX forbids opening this contract (status 25, FORBIDDEN_TO_OPEN in
    bingx-py) — the reconciler holds entries and adds instead of sending an order that comes
    back 109415 every round; reduces and closes still go out."""
    sym = _swap_symbol(env, symbol)
    if not sym.startswith("NC"):
        return True  # coins: no pause read, as before
    row = next((r for r in _contract_rows(env) if r.get("symbol") == sym), None)
    return not (row and str(row.get("status")) == str(_PAUSED))


def get_contract_rules(env, symbol):
    """Rules for one symbol. {'qty_precision', 'price_precision', 'min_qty',
    'min_notional', 'active'} — precisions are DECIMAL PLACES (BingX swap gives
    digit counts, not tick sizes). Cached per process."""
    symbol = _swap_symbol(env, symbol)
    if symbol not in _rules_cache:
        for r in _contract_rows(env):
            sym = r.get("symbol")
            if not sym:
                continue
            _rules_cache[sym] = {
                "qty_precision": int(r["quantityPrecision"]),
                "price_precision": int(r["pricePrecision"]),
                "min_qty": float(r["tradeMinQuantity"]),
                "min_notional": float(r.get("tradeMinUSDT", 2)),
                "active": str(r.get("apiStateOpen", "")).lower() == "true",
            }
    if symbol not in _rules_cache:
        raise BingXError("N/A", f"symbol {symbol} not found in /quote/contracts", "contracts", kind=reject_token.SYMBOL_UNAVAILABLE)
    return _rules_cache[symbol]


def _floor_to_precision(value, decimals):
    step = Decimal(1).scaleb(-decimals)  # 10^-decimals
    return Decimal(str(value)).quantize(step, rounding=ROUND_DOWN)


def format_qty(env, symbol, qty, price=None):
    """Floor qty to the symbol's precision and validate minimums. Returns a
    plain decimal string (never scientific notation). Raises ValueError if the
    floored qty is below min_qty, or below min_notional when price is given."""
    rules = get_contract_rules(env, symbol)
    if not rules["active"]:
        raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE, f"BingX 不開放這檔 API 下單（{symbol} is not open for API trading）"))
    q = _floor_to_precision(qty, rules["qty_precision"])
    if float(q) < rules["min_qty"]:
        raise ValueError(reject_token.tag(reject_token.BELOW_MIN_SIZE,
            f"{symbol} qty {qty} floors to {q}, below exchange minimum {rules['min_qty']}"
        ))
    if price is not None and float(q) * float(price) < rules["min_notional"]:
        raise ValueError(reject_token.tag(reject_token.BELOW_MIN_SIZE,
            f"{symbol} notional {float(q) * float(price):.4f} below minimum "
            f"{rules['min_notional']} USDT"
        ))
    return format(q, "f")


def format_price(env, symbol, price):
    """Floor price to the symbol's price precision. Returns a plain decimal string."""
    rules = get_contract_rules(env, symbol)
    return format(_floor_to_precision(price, rules["price_precision"]), "f")


# ── position mode ────────────────────────────────────────────────────────────

def get_position_mode(env):
    """'hedge' or 'oneway'. BingX returns dualSidePosition as the STRING
    "true"/"false". Cached per api key per process."""
    key = env.get("BINGX_API_KEY", "")
    if key not in _position_mode_cache:
        data = _request("GET", "/openApi/swap/v1/positionSide/dual", env) or {}
        _position_mode_cache[key] = (
            "hedge" if str(data.get("dualSidePosition", "")).lower() == "true" else "oneway"
        )
    return _position_mode_cache[key]


def _position_side(env, direction, closing=False):
    """direction: 'long'|'short' (of the POSITION). One-way mode always sends
    BOTH; hedge mode sends LONG/SHORT regardless of open/close."""
    if get_position_mode(env) == "oneway":
        return "BOTH"
    return direction.upper()


# ── orders ───────────────────────────────────────────────────────────────────

def _unwrap_order(data):
    """BingX nests the order object: {data: {order: {...}}}. orderId is a huge
    integer — return it as str and never let callers do float math on it."""
    order = (data or {}).get("order", data) or {}
    if "orderId" in order:
        order["orderId"] = str(order["orderId"])
    return order


def _is_post_only_reject(err):
    """True when a BingXError is the venue refusing a would-cross PostOnly
    order (code 101215 per the official error list; message match as a net
    for undocumented spot/gateway variants — BingX docs quality)."""
    if err.code in POST_ONLY_REJECT_CODES:
        return True
    msg = str(err.msg or "").lower()
    return "post only" in msg or "post-only" in msg or "postonly" in msg


def _is_order_gone(err, codes):
    """True when a cancel failed only because the order already left the book
    (filled / cancelled / unknown id) — the idempotent-safe cancel cases."""
    if err.code in codes:
        return True
    msg = str(err.msg or "").lower()
    return ("not exist" in msg or "does not exist" in msg
            or "order not found" in msg or "already filled" in msg
            or "already cancel" in msg)


def _normalize_open_rows(orders, canon=None):
    """In-place: give each open-order row the reconciler contract's trio —
    symbol (canonical dashless uppercase), order_id, client_order_id (BingX
    responses spell it clientOrderId; accept every spelling) — while keeping
    the raw fields (orderId stays, stringified)."""
    for o in orders:
        if "orderId" in o:
            o["orderId"] = str(o["orderId"])
        o["order_id"] = str(o.get("orderId", ""))
        o["symbol"] = (canon or (lambda v: str(v).replace("-", "").upper()))(o.get("symbol", ""))
        o["client_order_id"] = (o.get("clientOrderId") or o.get("clientOrderID")
                                or o.get("newClientOrderId") or "")
    return orders


def _attach_protection(params, sl_price=None, tp_price=None, qty=None):
    """Attach stopLoss/takeProfit to an entry order as BingX's stringified-JSON
    fields — one atomic request, no naked-position window."""
    if sl_price is not None:
        params["stopLoss"] = json.dumps({
            "type": "STOP_MARKET", "stopPrice": float(sl_price),
            "workingType": "MARK_PRICE", **({"quantity": float(qty)} if qty else {}),
        })
    if tp_price is not None:
        params["takeProfit"] = json.dumps({
            "type": "TAKE_PROFIT_MARKET", "stopPrice": float(tp_price),
            "workingType": "MARK_PRICE", **({"quantity": float(qty)} if qty else {}),
        })
    return params


def place_market_order(env, symbol, direction, qty, client_order_id=None,
                       reduce_only=False, sl_price=None, tp_price=None,
                       confirm_timeout=15):
    """Market order, CONFIRMED. direction: 'long'|'short' = the position this
    order builds (when reduce_only, the position it reduces). Returns the
    confirmed order dict from `confirm_order` — exchange-reported avg_price /
    executed_qty / commission, not intent.

    client_order_id: a unique-per-intent id ("mystrat20260709120500"; one is
    generated when omitted) — what an order whose answer was lost is looked up by
    (OrderNotConfirmed). It is not a resubmit guard: whether BingX refuses a reused
    id (101481) after the order filled is unverified. ALPHANUMERIC ONLY, 1-40
    chars, lowercased by BingX. Note the request param spelling is clientOrderID
    (official docs mix both spellings; capital ID is what ccxt ships in
    production), while query RESPONSES come back as clientOrderId."""
    guard.arm_restore(symbol, direction, qty, reduce_only)  # HALT's one netted-restore pass
    asked = symbol
    symbol = _swap_symbol(env, symbol)
    mode = get_position_mode(env)
    if reduce_only:
        side = "SELL" if direction == "long" else "BUY"
    else:
        side = "BUY" if direction == "long" else "SELL"
    params = {
        "symbol": symbol,
        "side": side,
        "positionSide": _position_side(env, direction),
        "type": "MARKET",
        "quantity": format_qty(env, symbol, qty),
    }
    if reduce_only and mode == "oneway":
        params["reduceOnly"] = "true"  # hedge mode expresses this via positionSide
    # without an id an order whose answer was lost could not be looked up again (= HALT)
    params["clientOrderID"] = client_order_id or f"bx{int(time.time() * 1000):x}{os.urandom(3).hex()}"
    _attach_protection(params, sl_price, tp_price)

    try:
        placed = _unwrap_order(_request("POST", "/openApi/swap/v2/trade/order", env, params))
        if not placed.get("orderId"):
            # code 0 = BingX took it; only the id is missing from the answer
            raise OrderNotConfirmed(
                f"order {params['clientOrderID']} accepted without an orderId ({placed}) — "
                f"it may have filled; check the position, do not resubmit",
                venue="bingx", client_order_id=params["clientOrderID"])
        return confirm_order(env, symbol, placed["orderId"], timeout=confirm_timeout)
    except OrderNotConfirmed as e:
        # the strategy's own symbol, not BingX's BTC-USDT / NCSK… (the park is queried with it)
        e.venue_symbol = asked
        e.client_order_id = e.client_order_id or params["clientOrderID"]
        raise


def place_limit_order(env, symbol, direction, qty, price, client_order_id=None,
                      reduce_only=False, time_in_force="GTC", post_only=False):
    """Limit order, UNCONFIRMED (may rest) — track via confirm_order /
    get_order. Returns the raw order dict with orderId + order_id (the
    chase-limit contract key), False when qty floors below the venue minimum
    (intentional skip — the chase executor treats it as dust), or
    {'status': 'post_only_rejected'} when a post-only order would cross.

    post_only=True sends timeInForce=PostOnly (BingX's maker-only dialect —
    official api-ai-skills repo + ccxt production; overrides time_in_force).
    A would-cross rejection is error 101215 per the official error list;
    NOT yet verified live — if the venue instead accepts then auto-cancels,
    the order surfaces as CANCELED via get_order and the chase executor
    accounts it the same way. price is floored to the symbol's tick here
    (callers pass a raw float)."""
    symbol = _swap_symbol(env, symbol)
    mode = get_position_mode(env)
    if reduce_only:
        side = "SELL" if direction == "long" else "BUY"
    else:
        side = "BUY" if direction == "long" else "SELL"
    try:
        qty_s = format_qty(env, symbol, qty, price=price)
    except ValueError as e:
        if "not open for API trading" in str(e):
            raise
        return False  # below min qty/notional — intentional skip
    params = {
        "symbol": symbol,
        "side": side,
        "positionSide": _position_side(env, direction),
        "type": "LIMIT",
        "quantity": qty_s,
        "price": format_price(env, symbol, price),
        "timeInForce": "PostOnly" if post_only else time_in_force,
    }
    if reduce_only and mode == "oneway":
        params["reduceOnly"] = "true"
    if client_order_id:
        params["clientOrderID"] = client_order_id
    try:
        order = _unwrap_order(_request("POST", "/openApi/swap/v2/trade/order", env, params))
    except BingXError as e:
        if post_only and _is_post_only_reject(e):
            return {"status": "post_only_rejected"}
        raise
    if not order.get("orderId"):
        raise BingXError("N/A", f"limit order response missing orderId: {order}", "trade/order")
    order["order_id"] = order["orderId"]
    return order


def get_order(env, symbol, order_id=None, client_order_id=None):
    """Order details by orderId, or by our client id (Query Order takes either and
    "can retrieve orders in any status (including filled or cancelled)" — official
    api-reference). Normalized: status, avg_price, executed_qty, orig_qty, commission
    (abs — BingX returns it negative), client_order_id, plus the raw dict under 'raw'."""
    if not order_id and not client_order_id:
        raise ValueError("get_order needs order_id or client_order_id")
    symbol = _swap_symbol(env, symbol)
    # the query spells it clientOrderId (lowercase d), unlike the order POST
    ident = {"orderId": str(order_id)} if order_id else {"clientOrderId": str(client_order_id)}
    data = _request("GET", "/openApi/swap/v2/trade/order", env, {"symbol": symbol, **ident})
    o = _unwrap_order(data)
    if "status" not in o:
        raise BingXError("N/A", f"order query missing status: {o}", "trade/order")
    return {
        "order_id": o["orderId"],
        "status": o["status"],
        "avg_price": float(o.get("avgPrice") or 0),
        "executed_qty": float(o.get("executedQty") or 0),
        "orig_qty": float(o.get("origQty") or 0),
        "commission": abs(float(o.get("commission") or 0)),
        # response uses lowercase-d clientOrderId (request uses clientOrderID)
        "client_order_id": o.get("clientOrderId") or o.get("clientOrderID") or "",
        "raw": o,
    }


# BingX emits BOTH enum families: docs-v3 says NEW/PENDING/PARTIALLYFILLED/
# CANCELLED/FAILED, the skills repo says PARTIALLY_FILLED/CANCELED/EXPIRED —
# accept the union; anything not terminal here is treated as still pending.
TERMINAL_STATUSES = {"FILLED", "CANCELED", "CANCELLED", "FAILED", "EXPIRED"}


def confirm_order(env, symbol, order_id, timeout=15):
    """Poll until the order reaches a terminal state. Returns get_order()'s
    normalized dict once it is FILLED, or terminal after a partial fill (the
    caller books what filled). Raises BingXError if it ended with nothing filled,
    OrderNotConfirmed if no terminal state was read before timeout — the order
    MAY STILL FILL; re-query, do not resubmit."""
    deadline = time.time() + timeout
    order = None
    last_err = None
    while time.time() < deadline:
        try:
            order = get_order(env, symbol, order_id)
        except Exception as e:
            # the id came from the placement answer: a read timeout, a 5xx, 100500 or
            # 109421 (the query side not caught up yet) leave its fate unknown, not rejected
            last_err = e
            time.sleep(1)
            continue
        if order["status"] == "FILLED":
            return order
        if order["status"] in TERMINAL_STATUSES:
            if order["executed_qty"] > 0:
                return order
            raise BingXError("N/A", f"order {order_id} ended {order['status']}", "confirm")
        time.sleep(1)
    if order is None:
        raise OrderNotConfirmed(
            f"order {order_id} accepted but not queryable ({type(last_err).__name__}: "
            f"{str(last_err)[:80]}) for {timeout}s — it may have filled; check the position, "
            f"do not resubmit", venue="bingx", venue_symbol=symbol, order_id=order_id)
    raise OrderNotConfirmed(
        f"order {order_id} still {order['status']} after {timeout}s",
        venue="bingx", venue_symbol=symbol, order_id=order_id)


def resolve_unknown_order(env, symbol, order_id=None, client_order_id=None, parked_at=None,
                          now=None):
    """A parked order's outcome (lib/unconfirmed): (executed_qty, avg_price) once it is
    terminal — qty 0 = it ended without a fill — None while unknown. Read-only: Query
    Order by orderId, or by our client id when only that is known. An order the query
    cannot find stays unknown however long ago it was parked: what BingX answers for an
    id that never arrived is unmeasured, and releasing an order that did fill is the
    duplicate this exists to prevent (the user's way out is unconfirmed.resolve)."""
    try:
        order = get_order(env, symbol, order_id=order_id, client_order_id=client_order_id)
    except Exception:
        return None
    if order["status"] not in TERMINAL_STATUSES:
        return None
    qty, price = order["executed_qty"], order["avg_price"]
    return (qty, price) if qty <= 0 or price > 0 else None


def get_open_orders(env, symbol=None):
    """All open orders (entry + conditional). Returns a list of raw order
    dicts, each augmented with the reconciler contract's symbol (canonical
    dashless) / order_id / client_order_id trio (see _normalize_open_rows)."""
    symbol = _swap_symbol(env, symbol) if symbol else symbol
    params = {"symbol": symbol} if symbol else {}
    data = _request("GET", "/openApi/swap/v2/trade/openOrders", env, params) or {}
    orders = data.get("orders", []) if isinstance(data, dict) else data
    return _normalize_open_rows(orders, lambda v: _canonical_symbol(env, v))


def get_bbo(env, symbol):
    """Top-of-book {'bid': float, 'ask': float} from /quote/depth — the real
    book, never mark/last price. Robust to BingX's inconsistent level ordering
    (ccxt's live captures show asks DESCENDING while the official docs say
    best-first): best bid = max, best ask = min over the returned levels.
    Fails loud on an empty book."""
    data = _request("GET", "/openApi/swap/v2/quote/depth", env,
                    {"symbol": _swap_symbol(env, symbol), "limit": "5"},
                    signed=False) or {}
    bids, asks = data.get("bids") or [], data.get("asks") or []
    if not bids or not asks:
        raise BingXError("N/A", f"empty depth for {symbol}: {list(data)}", "quote/depth")
    return {"bid": max(float(r[0]) for r in bids),
            "ask": min(float(r[0]) for r in asks)}


def cancel_order(env, symbol, order_id=None, client_order_id=None):
    """Cancel one order by orderId or clientOrderID. Returns the canceled
    order's raw dict (with order_id). Idempotent-safe: an order that is
    already filled / cancelled / unknown (109421, legacy 80016/80017) returns
    {'status': 'already_gone', ...} instead of raising — the caller always
    re-reads fills afterwards. Other refusals still raise BingXError."""
    symbol = _swap_symbol(env, symbol)
    params = {"symbol": symbol}
    if order_id:
        params["orderId"] = str(order_id)
    elif client_order_id:
        params["clientOrderID"] = client_order_id
    else:
        raise ValueError("order_id or client_order_id required")
    try:
        order = _unwrap_order(_request("DELETE", "/openApi/swap/v2/trade/order", env, params))
    except BingXError as e:
        if _is_order_gone(e, SWAP_ORDER_GONE_CODES):
            return {"status": "already_gone", "order_id": str(order_id or ""),
                    "client_order_id": client_order_id or ""}
        raise
    order["order_id"] = str(order.get("orderId", order_id or ""))
    return order


def cancel_all_orders(env, symbol):
    """Cancel ALL open orders for a symbol (including protective orders —
    only do this when also closing the position)."""
    return _request("DELETE", "/openApi/swap/v2/trade/allOpenOrders", env,
                    {"symbol": _swap_symbol(env, symbol)})


# ── protective orders (standalone) ───────────────────────────────────────────

def place_protective_orders(env, symbol, direction, qty=None, sl_price=None,
                            tp_price=None, verify=True):
    """Standalone reduce-only STOP_MARKET / TAKE_PROFIT_MARKET orders for an
    EXISTING position (use open_position's attached protection for new entries;
    use this for multi-level TPs or repairing protection).

    direction is the POSITION's direction ('long'|'short'); the protective
    orders take the opposite side automatically. qty=None protects the WHOLE
    position via closePosition=true (triggers a full close, survives later
    position-size changes — prefer it unless doing partial TPs). Verifies the
    orders exist on the exchange before returning. Raises ProtectionFailed if
    placement or verification fails — the caller MUST alert the user (naked
    position).

    VST quirk: the demo environment rejects closePosition=true with 109400
    ("parameter quantity or stopPrice is must") — on BINGX_DEMO=true, pass an
    explicit qty instead."""
    symbol = _swap_symbol(env, symbol)
    mode = get_position_mode(env)
    close_side = "SELL" if direction == "long" else "BUY"
    placed = {}
    try:
        for kind, otype, trigger in (
            ("sl", "STOP_MARKET", sl_price),
            ("tp", "TAKE_PROFIT_MARKET", tp_price),
        ):
            if trigger is None:
                continue
            params = {
                "symbol": symbol,
                "side": close_side,
                "positionSide": _position_side(env, direction),
                "type": otype,
                "stopPrice": format_price(env, symbol, trigger),
                "workingType": "MARK_PRICE",
            }
            if qty is None:
                # closePosition carries its own reduce-only semantics and
                # must NOT be combined with quantity or reduceOnly
                params["closePosition"] = "true"
            else:
                params["quantity"] = format_qty(env, symbol, qty)
                if mode == "oneway":
                    params["reduceOnly"] = "true"
            order = _unwrap_order(_request("POST", "/openApi/swap/v2/trade/order", env, params))
            if not order.get("orderId"):
                raise BingXError("N/A", f"{otype} response missing orderId", "trade/order")
            placed[kind] = order
    except guard.Halted as e:
        wanted = [k for k, p in (("sl", sl_price), ("tp", tp_price)) if p is not None]
        raise ProtectionFailed(
            guard.protection_halted_text(symbol, direction, wanted, placed, False) + f" {e}"
        ) from e
    except Exception as e:
        raise ProtectionFailed(
            f"{symbol} {direction} position may be NAKED — placing protective orders "
            f"failed after {list(placed)} succeeded: {e}"
        ) from e

    if verify and placed:
        open_ids = {o.get("orderId") for o in get_open_orders(env, symbol)}
        missing = [k for k, o in placed.items() if o["orderId"] not in open_ids]
        if missing:
            raise ProtectionFailed(
                f"{symbol} {direction}: protective order(s) {missing} were accepted but "
                f"are NOT in open orders — verify manually, position may be naked"
            )
    return placed


# ── high-level: the recommended entry flow ───────────────────────────────────

def open_position(env, symbol, direction, qty, sl_price=None, tp_price=None,
                  client_order_id=None, confirm_timeout=15):
    """Open a position the safe way: ONE atomic market order with stopLoss/
    takeProfit attached (no naked window), confirmed against the exchange,
    protection verified in open orders.

    Returns {'entry': confirmed order dict, 'protection': [raw conditional
    orders found on the exchange]}. Raises ProtectionFailed if sl/tp was
    requested but no conditional order is visible after the fill."""
    symbol = _swap_symbol(env, symbol)
    entry = place_market_order(
        env, symbol, direction, qty,
        client_order_id=client_order_id,
        sl_price=sl_price, tp_price=tp_price,
        confirm_timeout=confirm_timeout,
    )
    protection = []
    if sl_price is not None or tp_price is not None:
        # attached SL/TP become separate conditional orders once entry fills
        expected = (1 if sl_price is not None else 0) + (1 if tp_price is not None else 0)
        for _ in range(5):
            protection = [
                o for o in get_open_orders(env, symbol)
                if o.get("type") in ("STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT")
            ]
            if len(protection) >= expected:
                break
            time.sleep(1)
        if len(protection) < expected:
            raise ProtectionFailed(
                f"{symbol} {direction} entry FILLED (avg {entry['avg_price']}) but only "
                f"{len(protection)}/{expected} protective orders visible — position may be "
                f"naked, alert the user NOW"
            )
    return {"entry": entry, "protection": protection}


def close_position(env, symbol, direction, qty, client_order_id=None):
    """Market-close (part of) an existing position, confirmed. direction is the
    POSITION being closed ('long'|'short')."""
    symbol = _swap_symbol(env, symbol)
    return place_market_order(
        env, symbol, direction, qty,
        client_order_id=client_order_id, reduce_only=True,
    )


# ── fills ────────────────────────────────────────────────────────────────────

def get_fills(env, symbol, start_ms, end_ms):
    """Fill records for a time range (≤30 days back). Quirks handled: params
    are startTs/endTs (NOT startTime/endTime), response key is data.fill_orders
    (snake_case), filledTime is an ISO-8601 STRING (not ms). tradingUnit=COIN
    is sent so `volume` is already coin quantity (CONT would mean contracts)."""
    data = _request("GET", "/openApi/swap/v2/trade/allFillOrders", env, {
        "symbol": _swap_symbol(env, symbol),
        "startTs": str(int(start_ms)),
        "endTs": str(int(end_ms)),
        "tradingUnit": "COIN",
    }) or {}
    fills = data.get("fill_orders") if isinstance(data, dict) else data
    if fills is None:
        raise BingXError("N/A", f"allFillOrders missing fill_orders key: {list(data)}",
                         "allFillOrders")
    return fills


# ── leverage ─────────────────────────────────────────────────────────────────

def get_mark_price(env, symbol):
    """Live mark price (public premiumIndex) — the cross-venue wiring contract
    for USD→qty conversion (lib/venue_wiring.py)."""
    data = _request("GET", "/openApi/swap/v2/quote/premiumIndex", env,
                    {"symbol": _swap_symbol(env, symbol)}, signed=False)
    row = data[0] if isinstance(data, list) else data
    return float(row["markPrice"])


def set_leverage(env, symbol, leverage, side="LONG"):
    """Set leverage. In one-way mode BingX still takes side LONG/SHORT — set
    both sides for symmetry. Never silently inherit: query first, set only on
    user instruction (see references/manager.md confirmation rules)."""
    return _request("POST", "/openApi/swap/v2/trade/leverage", env, {
        "symbol": _swap_symbol(env, symbol), "side": side, "leverage": str(int(leverage)),
    })


def get_leverage(env, symbol):
    data = _request("GET", "/openApi/swap/v2/trade/leverage", env,
                    {"symbol": _swap_symbol(env, symbol)}) or {}
    return {
        "long": int(data.get("longLeverage") or data.get("leverage") or 0),
        "short": int(data.get("shortLeverage") or data.get("leverage") or 0),
    }


# ── VST demo ─────────────────────────────────────────────────────────────────

def claim_demo_funds(env, amount=100000):
    """Credit VST paper-trading balance (BINGX_DEMO=true only; the endpoint
    exists only on the VST domain). amount: whole number, ≤1,000,000 per call,
    10,000,000 lifetime cap."""
    if _bases(env) != [DEMO_URL]:
        raise ValueError("claim_demo_funds only works with BINGX_DEMO=true")
    return _request("POST", "/openApi/swap/v2/trade/getVst", env, {
        "adjustType": "0", "amount": str(int(amount)),
    })


def close_position_partial(env, symbol, direction, qty, client_order_id=None):
    """Cross-venue reconciler contract name. BingX's close_position already
    takes qty (partial-capable) — same call; OKX splits full vs partial, so
    the reconciler standardises on close_position_partial."""
    return close_position(env, symbol, direction, qty, client_order_id=client_order_id)


# ── spot execution (MARKET="spot" strategies) ────────────────────────────────
# Same guard/audit discipline as the swap layer; BingX spot quirks (verified
# against ccxt's production bingx parser): symbols are DASHED (BTC-USDT, same
# as swap); the client-id param is newClientOrderId (the swap layer's is
# clientOrderID — different casing AND name); market BUYs size in QUOTE
# currency via quoteOrderQty; spot rules come from the public
# /openApi/spot/v1/common/symbols where stepSize/tickSize are SIZES
# (0.0001), unlike swap's digit counts; placement may return status PENDING
# even for market orders — poll /openApi/spot/v1/trade/query to terminal.
# Broker attribution is the X-SOURCE-KEY header (already on every request).
# There are no positions and no leverage — inventory is the position.
#
# ASYMMETRIC MINIMUMS (measured live 2026-08-04): BTC-USDT buy minimum is
# 0.5 USDT notional but the SELL minimum is minQty 0.0001826 BTC (~$12) — a
# small buy can create inventory that cannot be sold on its own until more
# accumulates. place_spot_market_order returns False on such sells; callers
# treat it as dust, not an error.

from decimal import Decimal as _Dec, ROUND_DOWN as _RD

SPOT_TERMINAL_STATUSES = {"FILLED", "CANCELED", "CANCELLED", "FAILED"}

_spot_rules_cache = {}  # dashed symbol -> spot trading rules (per-process)


def _floor_to_step(value, step_str):
    return _Dec(str(value)).quantize(_Dec(str(step_str)).normalize(), rounding=_RD)


def get_spot_rules(env, symbol):
    """Spot trading rules: {'step': str, 'tick': str, 'min_qty': float,
    'min_notional': float, 'active': bool}. active needs BOTH api trade
    states plus status "1" (ccxt's gate)."""
    sym = _bingx_symbol(symbol)
    if sym not in _spot_rules_cache:
        data = _request("GET", "/openApi/spot/v1/common/symbols", env,
                        {"symbol": sym}, signed=False) or {}
        for r in data.get("symbols") or []:
            _spot_rules_cache[r.get("symbol")] = {
                "step": str(r.get("stepSize") or 1),
                "tick": str(r.get("tickSize") or "0.01"),
                "min_qty": float(r.get("minQty") or 0),
                "min_notional": float(r.get("minNotional") or 0),
                "active": bool(r.get("apiStateBuy")) and bool(r.get("apiStateSell"))
                          and str(r.get("status")) == "1",
            }
    if sym not in _spot_rules_cache:
        raise BingXError("N/A", f"symbol {sym} not in spot common/symbols", "symbols", kind=reject_token.SYMBOL_UNAVAILABLE)
    return _spot_rules_cache[sym]


def format_spot_qty(env, symbol, qty):
    """Floor a BASE qty to the spot step. Raises ValueError below min_qty or
    on a suspended symbol. Plain decimal string."""
    rules = get_spot_rules(env, symbol)
    if not rules["active"]:
        raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE, f"{symbol} is not open for spot trading"))
    q = _floor_to_step(qty, rules["step"])
    if float(q) < rules["min_qty"] or float(q) <= 0:
        raise ValueError(reject_token.tag(reject_token.BELOW_MIN_SIZE,
            f"{symbol} spot qty {qty} floors to {q}, below minimum {rules['min_qty']}"
        ))
    return format(q, "f")


def get_spot_price(env, symbol):
    """Last spot trade price (public 24hr ticker — /ticker/price is marked
    deprecated by BingX)."""
    data = _request("GET", "/openApi/spot/v1/ticker/24hr", env,
                    {"symbol": _bingx_symbol(symbol)}, signed=False)
    row = data[0] if isinstance(data, list) else data
    return float(row["lastPrice"])


def get_spot_balances(env):
    """{asset: free+locked} for every non-zero spot balance."""
    data = _request("GET", "/openApi/spot/v1/account/balance", env) or {}
    out = {}
    for b in data.get("balances") or []:
        amt = float(b.get("free") or 0) + float(b.get("locked") or 0)
        if amt > 0:
            out[b.get("asset")] = amt
    return out


def get_spot_order(env, symbol, order_id):
    """Spot order by id, normalized: status, avg_price, executed_qty,
    orig_qty (origQty — partial-fill accounting needs the original size),
    quote_qty, client_order_id, raw."""
    o = _request("GET", "/openApi/spot/v1/trade/query", env,
                 {"symbol": _bingx_symbol(symbol), "orderId": str(order_id)}) or {}
    if "status" not in o:
        raise BingXError("N/A", f"spot order query missing status: {list(o)}", "trade/query")
    executed = float(o.get("executedQty") or 0)
    quote = float(o.get("cummulativeQuoteQty") or 0)
    return {
        "order_id": str(o.get("orderId", "")),
        "status": o.get("status"),
        "avg_price": (quote / executed) if executed else 0.0,
        "executed_qty": executed,
        "orig_qty": float(o.get("origQty") or 0),
        "quote_qty": quote,
        "client_order_id": (o.get("clientOrderId") or o.get("clientOrderID")
                            or o.get("newClientOrderId") or ""),
        "raw": o,
    }


def place_spot_market_order(env, symbol, side, base_qty=None, quote_qty=None,
                            client_order_id=None, confirm_timeout=15):
    """Confirmed spot market order. side: 'buy'|'sell'.

    BUYs pass quote_qty (USDT — quoteOrderQty, no price conversion on our
    side); SELLs pass base_qty (floored to the spot step — you can only sell
    inventory you hold). Below min qty/notional → returns False (intentional
    skip). Polls to a terminal state; returns get_spot_order()'s dict.
    Guard: buy=entry, sell=reduce."""
    sym = _bingx_symbol(symbol)
    side = side.lower()
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be buy|sell, got {side!r}")
    rules = get_spot_rules(env, sym)
    params = {"symbol": sym, "side": side.upper(), "type": "MARKET"}
    if client_order_id:
        params["newClientOrderId"] = client_order_id  # spot param name (swap uses clientOrderID)
    if side == "buy":
        if quote_qty is None:
            raise ValueError("spot buys are sized in quote currency — pass quote_qty")
        if float(quote_qty) < rules["min_notional"]:
            return False  # below min notional — intentional skip
        params["quoteOrderQty"] = f"{float(quote_qty):.2f}"
    else:
        if base_qty is None:
            raise ValueError("spot sells are sized in base currency — pass base_qty")
        try:
            params["quantity"] = format_spot_qty(env, sym, base_qty)
        except ValueError as e:
            if "not open for spot trading" in str(e):
                raise
            return False  # below min qty — intentional skip

    data = _request("POST", "/openApi/spot/v1/trade/order", env, params)
    order = data if isinstance(data, dict) else {}
    order_id = order.get("orderId")
    if not order_id:
        raise BingXError("N/A", f"spot order response missing orderId: {list(order)}",
                         "trade/order")
    deadline = time.time() + confirm_timeout
    result = None
    while time.time() < deadline:
        result = get_spot_order(env, sym, order_id)
        if result["status"] == "FILLED":
            return result
        if result["status"] in SPOT_TERMINAL_STATUSES:
            raise BingXError("N/A", f"spot order {order_id} ended {result['status']}",
                             "confirm")
        time.sleep(1)
    raise OrderNotConfirmed(
        f"spot order {order_id} still {result['status'] if result else 'UNKNOWN'} "
        f"after {confirm_timeout}s"
    )


# ── spot limit layer (chase-limit executor contract) ─────────────────────────

def format_spot_price(env, symbol, price):
    """Floor a price to the spot tick (tickSize is a SIZE, unlike swap's digit
    counts). Plain decimal string."""
    rules = get_spot_rules(env, symbol)
    return format(_floor_to_step(price, rules["tick"]), "f")


def place_spot_limit_order(env, symbol, side, base_qty, price, client_order_id=None,
                           post_only=False):
    """Limit spot order, UNCONFIRMED (may rest) — track via get_spot_order.
    side: 'buy'|'sell'; sized in BASE qty for BOTH sides (unlike market buys,
    which take quote_qty — limit orders carry their own price). Returns the
    order dict with order_id, False below min qty/notional (intentional skip,
    same convention as place_spot_market_order), or
    {'status': 'post_only_rejected'} when a post-only order would cross.

    post_only=True sends timeInForce=PostOnly (official api-ai-skills repo +
    ccxt production — same dialect as swap). The spot rejection presentation
    is NOT verified live and the official error list has no spot twin of
    swap's 101215, so detection is message-based; an accept-then-auto-cancel
    dialect surfaces as CANCELED via get_spot_order instead, which the chase
    executor accounts the same way. qty is floored to the spot step and price
    to the spot tick here (callers pass raw floats).
    Guard: buy=entry, sell=reduce."""
    sym = _bingx_symbol(symbol)
    side = side.lower()
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be buy|sell, got {side!r}")
    rules = get_spot_rules(env, sym)
    try:
        qty_s = format_spot_qty(env, sym, base_qty)
    except ValueError as e:
        if "not open for spot trading" in str(e):
            raise
        return False  # below min qty — intentional skip
    price_s = format_spot_price(env, sym, price)
    if float(qty_s) * float(price_s) < rules["min_notional"]:
        return False  # below min notional — intentional skip
    params = {
        "symbol": sym,
        "side": side.upper(),
        "type": "LIMIT",
        "quantity": qty_s,
        "price": price_s,
        "timeInForce": "PostOnly" if post_only else "GTC",
    }
    if client_order_id:
        params["newClientOrderId"] = client_order_id  # spot param name (swap uses clientOrderID)
    try:
        data = _request("POST", "/openApi/spot/v1/trade/order", env, params)
    except BingXError as e:
        if post_only and _is_post_only_reject(e):
            return {"status": "post_only_rejected"}
        raise
    order = data if isinstance(data, dict) else {}
    if not order.get("orderId"):
        raise BingXError("N/A", f"spot limit response missing orderId: {list(order)}",
                         "trade/order")
    order["orderId"] = str(order["orderId"])
    order["order_id"] = order["orderId"]
    return order


def cancel_spot_order(env, symbol, order_id):
    """Cancel one spot order by orderId (POST — BingX spot has no DELETE
    cancel). Idempotent-safe: already filled / not found (100404 per the
    official spot error list) returns {'status': 'already_gone', ...} instead
    of raising — the caller always re-reads fills afterwards."""
    try:
        data = _request("POST", "/openApi/spot/v1/trade/cancel", env,
                        {"symbol": _bingx_symbol(symbol), "orderId": str(order_id)})
    except BingXError as e:
        if _is_order_gone(e, SPOT_ORDER_GONE_CODES):
            return {"status": "already_gone", "order_id": str(order_id)}
        raise
    order = data if isinstance(data, dict) else {}
    if "orderId" in order:
        order["orderId"] = str(order["orderId"])
    order["order_id"] = str(order.get("orderId", order_id))
    return order


def get_spot_bbo(env, symbol):
    """Spot top-of-book {'bid': float, 'ask': float} from /market/depth — the
    real book. Same ordering-robust max/min read as the swap get_bbo (BingX's
    level ordering is inconsistent between docs and live captures)."""
    data = _request("GET", "/openApi/spot/v1/market/depth", env,
                    {"symbol": _bingx_symbol(symbol), "limit": "5"},
                    signed=False) or {}
    bids, asks = data.get("bids") or [], data.get("asks") or []
    if not bids or not asks:
        raise BingXError("N/A", f"empty spot depth for {symbol}: {list(data)}", "market/depth")
    return {"bid": max(float(r[0]) for r in bids),
            "ask": min(float(r[0]) for r in asks)}


def get_spot_open_orders(env, symbol=None):
    """Open spot orders (all pairs when symbol=None). Returns raw order dicts,
    each augmented with the reconciler contract's symbol (canonical dashless) /
    order_id / client_order_id trio (see _normalize_open_rows)."""
    params = {"symbol": _bingx_symbol(symbol)} if symbol else {}
    data = _request("GET", "/openApi/spot/v1/trade/openOrders", env, params) or {}
    orders = data.get("orders", []) if isinstance(data, dict) else data
    return _normalize_open_rows(orders or [])
