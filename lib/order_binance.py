"""
Binance USDⓈ-M futures order execution library.

Companion to lib/account_binance.py (equity/positions). Credentials:
BINANCE_API_KEY, BINANCE_SECRET_KEY in .env. Set BINANCE_DEMO=true to run the
same code on Binance Demo Trading — futures demo-fapi.binance.com, spot
demo-api.binance.com — with keys from demo.binance.com (unlike BingX's VST,
which reuses live keys).

Broker attribution (Blave) is PER ORDER on Binance, not a header: every order
placement carries newClientOrderId starting with x-52DDFAFN (USDS-M futures
broker ID). This lib builds the id itself — callers pass a plain
client_order_id suffix and never handle the prefix.

Design rules (same contract as lib/order_bingx.py — non-negotiable):

1. FAIL LOUD. Every unexpected response shape raises BinanceError with the
   exchange's own code and message.
2. CONFIRMED, NOT SENT. Orders are polled to a terminal state; callers get
   what the EXCHANGE says (avgPrice, executedQty, commission) — never intent.
3. NO NAKED POSITIONS (best effort). Binance futures has no atomic SL/TP
   attach on the entry order (unlike BingX) — open_position places the entry,
   then protective orders, and VERIFIES them on the exchange; a protection
   failure raises ProtectionFailed, which callers must surface immediately.
4. IDEMPOTENT (bounded). newClientOrderId is unique per intent; Binance
   rejects a duplicate against an OPEN order (-2022/-4116 family) but reuses
   ids freely once the order is terminal — so on OrderNotConfirmed, re-query;
   never blindly resubmit.
5. HALTABLE + AUDITED. Every order-mutating request passes through lib/guard:
   state/HALT blocks every order BEFORE any network call — entries, closes,
   SL/TP; cancels still pass, closes only inside the user's explicit close
   (lib/guard close pass) — and every attempt/outcome/denial lands in
   state/audit.jsonl.

Verified against ccxt's production binance parser + official docs + live
orders on the real account (2026-08-04). Binance quirks handled here:
quantity is BASE units already (no contract conversion anywhere — ctVal=1);
hedge mode REJECTS the reduceOnly param (-1106; closing is expressed by
side-opposite-positionSide instead); order query returns no commission
(fetched best-effort from userTrades); dualSidePosition is a real JSON
boolean (BingX returns the string "true"); orderId is a large integer (kept
as str); CONDITIONAL orders (SL/TP/trailing) live on a SEPARATE Algo Order
API — /fapi/v1/order rejects STOP_MARKET with -4120 (measured live) — with
its own vocabulary: triggerPrice not stopPrice, clientAlgoId not
newClientOrderId (broker prefix still applies), algoId/algoStatus in
responses, and their own open/cancel endpoints (openAlgoOrders /
algoOpenOrders) — /fapi/v1/openOrders does NOT list them.
"""

import hashlib
import hmac
import os
import time
from decimal import Decimal, ROUND_DOWN
from urllib.parse import urlencode

import requests

from lib import guard
try:
    from lib import reject_token
except ImportError:  # half-updated workspace (lib/reject_token.py not landed): orders work, messages go out untagged
    from types import SimpleNamespace as _NS
    reject_token = _NS(tag=lambda kind, msg: str(msg), from_code=lambda *a, **k: None, credential_codes=lambda v: frozenset(),
                       **{k: k.lower() for k in ("INSUFFICIENT_MARGIN", "BELOW_MIN_SIZE", "SYMBOL_UNAVAILABLE",
                                                 "KEY_PERMISSION", "REDUCE_ONLY_REJECTED", "PAPER_MARGIN")})

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)

LIVE_URL = "https://fapi.binance.com"
DEMO_URL = "https://demo-fapi.binance.com"  # futures testnet (testnet keys)
SPOT_LIVE_URL = "https://api.binance.com"
# Spot Demo Mode, same demo.binance.com keys as demo-fapi. Not testnet.binance.vision:
# that is the separate Spot Test Network, whose keys demo keys are not.
SPOT_DEMO_URL = "https://demo-api.binance.com"

BROKER_PREFIX = "x-52DDFAFN"  # Blave USDS-M futures broker ID — every order
CID_MAX = 36                  # Binance newClientOrderId hard limit

RETRYABLE_CODES = {-1001}  # internal error / disconnected. Rate limits
                           # (-1003 / HTTP 429) are deliberately NOT retried:
                           # hammering through them escalates to an IP ban.
                           # Reads only: an order POST is never resent (_send no_resend).
# An order POST answered with one of these (or a read timeout, a dropped connection, a
# 5xx) may have executed: the futures error-code page says -1006 / -1007 "execution
# status unknown", general-info says an HTTP 503 "Unknown error…" "could have been a
# success". -1000 / -1001 are listed as failures there, but a resend under the same
# newClientOrderId is only refused while that order is OPEN ("A unique id among open
# orders") and a market order is terminal at once — so the POST is not resent; the
# order is looked up by its client id instead (lib/unconfirmed).
SEND_UNKNOWN_CODES = {-1000, -1001, -1006, -1007}
RECV_WINDOW = "5000"

_rules_cache = {}          # symbol -> contract rules (per-process)
_position_mode_cache = {}  # api_key -> "hedge" | "oneway"
_time_offset = {"ms": 0}   # server-clock correction, set on -1021


class _SendUnknown(Exception):
    """An order POST whose outcome is unknown (see SEND_UNKNOWN_CODES); _request turns
    it into OrderNotConfirmed carrying the client order id."""


class BinanceError(Exception):
    """Raised on any Binance error response or unexpected shape."""

    def __init__(self, code, msg, path="", kind=None):
        self.code = code
        self.msg = msg
        kind = kind or _reject_kind(code, msg)
        text = f"Binance error {code}: {msg or '(empty msg)'} | {path}"
        if kind == _STOCK_AGREEMENT:
            text = f"要先簽 Binance 股票永續（TradFi-Perps）協議：App 和網頁都沒有簽署處，跟 agent 說「幫我簽 Binance 股票合約協議」，它會在你同意後代簽；簽完下一輪自動再下（{text}）"
        super().__init__(reject_token.tag(kind, text))


# lib/reject_token kinds, from Binance's official error pages: USDⓈ-M futures
# (-2019 MARGIN_NOT_SUFFICIEN, -2022 REDUCE_ONLY_REJECT, -4118
# REDUCE_ONLY_MARGIN_CHECK_FAILED) and spot (-2010 NEW_ORDER_REJECTED is shared by
# many rejections — only its documented "Account has insufficient balance for
# requested action." message counts). Rejected keys: account_binance._CREDENTIAL.
# -4411 "Please sign TradFi-Perps agreement contract" is not on the error page; measured on the
# demo account 2026-10-19/20 placing NVDAUSDT / AMZNUSDT. Only the user signs it (in the app).
_STOCK_AGREEMENT = getattr(reject_token, "STOCK_AGREEMENT", "stock_agreement")
_REJECT_CODES = {"-2019": reject_token.INSUFFICIENT_MARGIN, "-2022": reject_token.REDUCE_ONLY_REJECTED,
                 "-4118": reject_token.REDUCE_ONLY_REJECTED, "-4411": _STOCK_AGREEMENT}


def _reject_kind(code, msg):
    if str(code) == "-2010" and "insufficient balance" in str(msg or "").lower():
        return reject_token.INSUFFICIENT_MARGIN
    return reject_token.from_code(code, _REJECT_CODES, reject_token.credential_codes("binance"))


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
    """Order was accepted but did not reach a terminal state within timeout.
    The order may still fill — query it again before assuming anything.
    Carries venue / venue_symbol / order_id so lib/portfolio.reconcile can park it."""


class ProtectionFailed(Exception):
    """Position is OPEN but a protective (SL/TP) order could not be placed or
    verified. The position is NAKED — alert the user immediately."""


# ── transport ────────────────────────────────────────────────────────────────

def _base(env, spot=False):
    demo = str(env.get("BINANCE_DEMO", os.environ.get("BINANCE_DEMO", ""))).lower() == "true"
    if spot:
        return SPOT_DEMO_URL if demo else SPOT_LIVE_URL
    return DEMO_URL if demo else LIVE_URL


def _canonical(sym):
    """Canonical == Binance futures format already (dashless uppercase).
    Strip separators defensively so 'BTC-USDT' from a stray caller still works."""
    return (sym or "").replace("-", "").replace("_", "").upper()


def _sync_time(env):
    """-1021 = our clock drifted outside recvWindow. Correct against the
    venue's clock instead of failing every order on machine drift."""
    server = requests.get(f"{_base(env)}/fapi/v1/time", timeout=10).json()["serverTime"]
    _time_offset["ms"] = int(server) - int(time.time() * 1000)


# Order-mutating endpoints and how to classify their intent for the guard.
_MUTATING_PATHS = {
    ("POST", "/api/v3/order"): "place",
    ("DELETE", "/api/v3/order"): "cancel",
    ("DELETE", "/api/v3/openOrders"): "cancel_all",
    ("POST", "/fapi/v1/order"): "place",
    ("POST", "/fapi/v1/algoOrder"): "place",
    ("DELETE", "/fapi/v1/order"): "cancel",
    ("DELETE", "/fapi/v1/algoOrder"): "cancel",
    ("DELETE", "/fapi/v1/allOpenOrders"): "cancel_all",
    ("DELETE", "/fapi/v1/algoOpenOrders"): "cancel_all",
    ("POST", "/fapi/v1/leverage"): "leverage",
}

_PROTECTIVE_TYPES = {"STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT",
                     "TRAILING_STOP_MARKET"}

# Params worth keeping in the audit line (no secrets live in params — the
# signature and timestamp are added later, inside _send's own copy).
_AUDIT_PARAM_KEYS = ("symbol", "side", "positionSide", "type", "quantity",
                     "price", "stopPrice", "triggerPrice", "newClientOrderId",
                     "clientAlgoId", "reduceOnly", "closePosition", "leverage",
                     "orderId", "algoId")


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
    if path == "/api/v3/order":
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


def _request(method, path, env, params=None, signed=True, retries=3, spot=False):
    """Gate + audit wrapper around _send. Reads pass straight through;
    order-mutating requests are halt-checked and audited (design rule 5)."""
    intent = _order_intent(method, path, params)
    if intent is None:
        return _send(method, path, env, params, signed, retries, spot)
    placing = _MUTATING_PATHS.get((method, path)) == "place"

    fields = {k: params[k] for k in _AUDIT_PARAM_KEYS if k in (params or {})}
    fields["intent"] = intent
    guard.check_restart_stop(intent, fields)
    guard.check_account_hold("binance", intent, fields)
    fields["demo"] = _base(env) == DEMO_URL

    if intent == "entry" and guard.entry_blocked():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for "
            f"{fields.get('symbol')} refused before reaching the exchange. "
            f"Trading is paused: only cancels go out (closes on the user's explicit "
            f"close only). Only the user may clear the halt (guard.clear_halt)."
        )

    guard.audit("order_attempt", **fields)
    try:
        data = _send(method, path, env, params, signed, retries, spot, no_resend=placing)
    except _SendUnknown as e:
        cid = (params or {}).get("newClientOrderId")
        guard.audit("order_unknown", error=str(e), client_order_id=cid, **fields)
        # only a futures order can be looked up again by its client id here (get_order);
        # spot / algo orders raise without a venue = not parkable = HALT (lib/portfolio)
        futures = path == "/fapi/v1/order"
        raise OrderNotConfirmed(
            f"order {cid} sent, no answer ({e}) — it may have filled; check the position, "
            f"do not resubmit", venue="binance" if futures else None,
            venue_symbol=(params or {}).get("symbol") if futures else None,
            client_order_id=cid) from e
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise
    order_id = (data or {}).get("orderId", "") if isinstance(data, dict) else ""
    guard.audit("order_ok", order_id=str(order_id), **fields)
    return data


def _send(method, path, env, params=None, signed=True, retries=3, spot=False, plain_text=False,
          no_resend=False):
    """no_resend (order POSTs): once the request may have reached Binance it is never sent
    again — a read timeout, a dropped connection, a 5xx or a SEND_UNKNOWN_CODES answer raises
    _SendUnknown. Only a connect timeout (nothing sent) and -1021 (refused before matching,
    re-signed) are retried."""
    api_key = env.get("BINANCE_API_KEY")
    secret_key = env.get("BINANCE_SECRET_KEY")
    if signed and (not api_key or not secret_key):
        raise ValueError("BINANCE_API_KEY / BINANCE_SECRET_KEY missing from .env")

    headers = {"X-MBX-APIKEY": api_key} if signed else {}
    last_err = None
    for attempt in range(retries):
        if signed:
            p = dict(params or {})
            p["timestamp"] = int(time.time() * 1000) + _time_offset["ms"]
            p.setdefault("recvWindow", RECV_WINDOW)
            qs = urlencode(p)
            sig = hmac.new(secret_key.encode(), qs.encode(), hashlib.sha256).hexdigest()
            payload = f"{qs}&signature={sig}"  # signature must be last
        else:
            payload = urlencode(params or {})

        try:
            if method == "POST":
                r = requests.post(
                    f"{_base(env, spot)}{path}", data=payload,
                    headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
                    timeout=10,
                )
            else:
                url = f"{_base(env, spot)}{path}" + (f"?{payload}" if payload else "")
                r = requests.request(method, url, headers=headers, timeout=10)
        except requests.exceptions.ConnectTimeout as e:
            last_err = e   # no connection was made: nothing reached Binance
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt)
            continue
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            if no_resend:
                raise _SendUnknown(f"{type(e).__name__}: {str(e)[:120]}") from e
            if isinstance(e, requests.exceptions.Timeout):
                raise
            last_err = e
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt)
            continue
        if no_resend and r.status_code >= 500:
            raise _SendUnknown(f"HTTP {r.status_code}: {r.text[:120]}")

        try:
            data = r.json()
        except ValueError:
            # plain_text: endpoints that answer a bare word on success (sign_stock_agreement → "SUCCESS")
            if plain_text and 200 <= r.status_code < 300:
                return r.text.strip()
            raise BinanceError(r.status_code, f"non-JSON response ({r.text[:120]})", path)
        # Errors are {"code": <negative int>, "msg": "..."} with a 4xx status.
        if isinstance(data, dict) and isinstance(data.get("code"), int) \
                and data["code"] < 0 and "msg" in data:
            code = data["code"]
            if code == -1021:
                _sync_time(env)
                last_err = BinanceError(code, data.get("msg"), path)
                continue  # resigned with corrected clock next attempt
            if no_resend and code in SEND_UNKNOWN_CODES:
                raise _SendUnknown(f"{code}: {data.get('msg')}")
            if code in RETRYABLE_CODES and attempt < retries - 1:
                last_err = BinanceError(code, data.get("msg"), path)
                time.sleep(1 + attempt)
                continue
            raise BinanceError(code, data.get("msg"), path)
        return data
    raise last_err


# ── broker client-order-id ───────────────────────────────────────────────────

def _cid(client_order_id=None):
    """Build the attributed newClientOrderId: x-52DDFAFN + caller suffix (or a
    time-based one). Raises instead of truncating an over-long caller id —
    silent truncation could collide two intents and break idempotency."""
    suffix = client_order_id or f"{int(time.time() * 1000):x}"
    cid = f"{BROKER_PREFIX}{suffix}"
    if len(cid) > CID_MAX:
        raise ValueError(
            f"client_order_id too long: {len(suffix)} chars, max "
            f"{CID_MAX - len(BROKER_PREFIX)} after the broker prefix"
        )
    return cid


# ── contract rules / quantity formatting ────────────────────────────────────

def get_contract_rules(env, symbol):
    """Rules for one symbol: {'step': str, 'min_qty': float, 'min_notional':
    float, 'contract_value': 1.0, 'price_tick': str, 'active': bool}.
    Binance futures quantity IS base units — contract_value is always 1.0
    (kept for the cross-venue contract). Cached per process (exchangeInfo is
    one big call for every symbol)."""
    symbol = _canonical(symbol)
    if not _rules_cache:
        info = _send("GET", "/fapi/v1/exchangeInfo", env, signed=False)
        for s in info.get("symbols", []):
            filters = {f.get("filterType"): f for f in s.get("filters", [])}
            lot = filters.get("LOT_SIZE", {})
            mkt = filters.get("MARKET_LOT_SIZE", {})
            _rules_cache[s["symbol"]] = {
                "step": mkt.get("stepSize") or lot.get("stepSize") or "1",
                # market orders must satisfy BOTH filters — take the stricter
                "min_qty": max(float(lot.get("minQty", 0)), float(mkt.get("minQty", 0))),
                "max_qty": float(mkt.get("maxQty") or lot.get("maxQty") or 0) or None,
                "min_notional": float(filters.get("MIN_NOTIONAL", {}).get("notional", 0)),
                "contract_value": 1.0,
                "price_tick": filters.get("PRICE_FILTER", {}).get("tickSize", "0.01"),
                "active": s.get("status") == "TRADING",
            }
    if symbol not in _rules_cache:
        raise BinanceError("N/A", f"symbol {symbol} not found in /fapi/v1/exchangeInfo",
                           "exchangeInfo", kind=reject_token.SYMBOL_UNAVAILABLE)
    return _rules_cache[symbol]


def _floor_to_step(value, step_str):
    return Decimal(str(value)).quantize(Decimal(step_str).normalize(), rounding=ROUND_DOWN)


def format_qty(env, symbol, qty, price=None):
    """Floor a BASE-currency qty to the symbol's step and validate minimums.
    Returns a plain decimal string (never scientific notation). Raises
    ValueError below min_qty, or below min_notional when price is given.
    Callers use this as the min-size gate ONLY — never feed the result into
    place_market_order (units pitfall, references/manager.md)."""
    rules = get_contract_rules(env, symbol)
    if not rules["active"]:
        raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE, f"{symbol} is not open for trading"))
    q = _floor_to_step(qty, rules["step"])
    if float(q) < rules["min_qty"] or float(q) <= 0:
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
    """Floor price to the symbol's tick size. Returns a plain decimal string."""
    rules = get_contract_rules(env, symbol)
    return format(_floor_to_step(price, rules["price_tick"]), "f")


# ── position mode ────────────────────────────────────────────────────────────

def get_position_mode(env):
    """'hedge' or 'oneway'. Binance returns dualSidePosition as a real JSON
    boolean (not BingX's string). Cached per api key per process."""
    key = env.get("BINANCE_API_KEY", "")
    if key not in _position_mode_cache:
        data = _request("GET", "/fapi/v1/positionSide/dual", env) or {}
        _position_mode_cache[key] = "hedge" if data.get("dualSidePosition") else "oneway"
    return _position_mode_cache[key]


def _position_side(env, direction):
    """direction: 'long'|'short' (of the POSITION). One-way mode sends BOTH;
    hedge mode sends LONG/SHORT regardless of open/close."""
    if get_position_mode(env) == "oneway":
        return "BOTH"
    return direction.upper()


# ── orders ───────────────────────────────────────────────────────────────────

def _norm_ids(o):
    """orderId/algoId are huge integers — keep them as str, never float math."""
    if isinstance(o, dict):
        for k in ("orderId", "algoId"):
            if k in o:
                o[k] = str(o[k])
    return o


def place_market_order(env, symbol, direction, qty, client_order_id=None,
                       reduce_only=False, confirm_timeout=15):
    """Market order, CONFIRMED. qty is BASE currency (= Binance's own unit).
    direction: 'long'|'short' = the position this order builds (when
    reduce_only, the position it reduces). Returns confirm_order()'s dict —
    exchange-reported avg_price / executed_qty / commission, never intent.
    Below min qty/notional → returns False (intentional skip, the reconciler
    convention — no phantom-trade notification).

    client_order_id: unique-per-intent suffix ("mystrat20260709120500"),
    ≤26 chars — the broker prefix x-52DDFAFN is prepended here. Duplicate ids
    are rejected by Binance only while the original order is OPEN; a terminal
    order's id is reusable, so treat this as a retry-window guard, not a
    permanent ledger (see OrderNotConfirmed)."""
    guard.arm_restore(symbol, direction, qty, reduce_only)  # HALT's one netted-restore pass
    symbol = _canonical(symbol)
    mode = get_position_mode(env)
    try:
        qty_str = format_qty(env, symbol, qty)
    except ValueError as e:
        # a suspended symbol is a FAULT, not an intentional min-size skip —
        # swallowing it would leave a close silently unexecuted (audit S4)
        if "not open for trading" in str(e):
            raise
        return False
    if reduce_only:
        side = "SELL" if direction == "long" else "BUY"
    else:
        side = "BUY" if direction == "long" else "SELL"
    params = {
        "symbol": symbol,
        "side": side,
        "positionSide": _position_side(env, direction),
        "type": "MARKET",
        "quantity": qty_str,
        "newClientOrderId": _cid(client_order_id),
    }
    # hedge mode REJECTS reduceOnly (-1106) — there, closing is already fully
    # expressed by side being opposite to positionSide
    if reduce_only and mode == "oneway":
        params["reduceOnly"] = "true"

    try:
        placed = _norm_ids(_request("POST", "/fapi/v1/order", env, params))
    except BinanceError as e:
        # -4164 = below MIN_NOTIONAL. format_qty can't pre-check it here (no
        # price arg on market orders), and Binance EXEMPTS reduce-only orders
        # from the check — so let the exchange decide and map its rejection to
        # the contract's intentional-skip False (audit S3).
        if e.code == -4164:
            return False
        raise
    if not placed.get("orderId"):
        raise BinanceError("N/A", f"order response missing orderId: {placed}", "order")
    try:
        return confirm_order(env, symbol, placed["orderId"], timeout=confirm_timeout)
    except OrderNotConfirmed as e:
        e.client_order_id = e.client_order_id or params["newClientOrderId"]
        raise


def place_limit_order(env, symbol, direction, qty, price, client_order_id=None,
                      reduce_only=False, time_in_force="GTC", post_only=False):
    """Limit order, UNCONFIRMED (it may rest) — use confirm_order / get_order
    to track it. Returns the raw order dict plus a normalized 'order_id' key
    (the chase-limit contract: every later cancel/status call is by order_id).
    Below min qty/notional → returns False (intentional skip, same convention
    as place_market_order — the chase toolkit sizes legs in USD and small
    residuals are expected). price is floored to the symbol's tick here —
    callers pass a raw float.

    post_only=True sends timeInForce=GTX (Binance futures' post-only dialect,
    overriding time_in_force); a GTX order that would cross is refused with
    -5022 GTX_ORDER_REJECT and RETURNS {'status': 'post_only_rejected'}
    instead of raising — the chase executor re-reads the book and re-posts."""
    symbol = _canonical(symbol)
    mode = get_position_mode(env)
    if reduce_only:
        side = "SELL" if direction == "long" else "BUY"
    else:
        side = "BUY" if direction == "long" else "SELL"
    price_str = format_price(env, symbol, price)
    try:
        # Binance EXEMPTS reduce-only orders from MIN_NOTIONAL (-4164, same
        # exemption place_market_order relies on) — skip the notional pre-check
        # there so small residual closes ($10-100) aren't blocked by our own
        # gate; step/min_qty checks still apply either way.
        qty_str = format_qty(env, symbol, qty,
                             price=None if reduce_only else price_str)
    except ValueError as e:
        # a suspended symbol is a FAULT, not an intentional min-size skip
        if "not open for trading" in str(e):
            raise
        return False
    params = {
        "symbol": symbol,
        "side": side,
        "positionSide": _position_side(env, direction),
        "type": "LIMIT",
        "quantity": qty_str,
        "price": price_str,
        "timeInForce": "GTX" if post_only else time_in_force,
        "newClientOrderId": _cid(client_order_id),
    }
    if reduce_only and mode == "oneway":
        params["reduceOnly"] = "true"
    try:
        placed = _norm_ids(_request("POST", "/fapi/v1/order", env, params))
    except BinanceError as e:
        if post_only and e.code == -5022:
            return {"status": "post_only_rejected"}
        raise
    if not placed.get("orderId"):
        raise BinanceError("N/A", f"order response missing orderId: {placed}", "order")
    placed["order_id"] = placed["orderId"]
    return placed


def get_order(env, symbol, order_id=None, client_order_id=None):
    """Order details by orderId, or by our newClientOrderId (origClientOrderId — Query
    Order takes either). Normalized: status, avg_price, executed_qty, orig_qty,
    client_order_id, plus the raw dict under 'raw'. Commission is NOT in Binance's
    order query — confirm_order adds it from userTrades."""
    ident = {"orderId": str(order_id)} if order_id else {"origClientOrderId": str(client_order_id)}
    if not order_id and not client_order_id:
        raise ValueError("get_order needs order_id or client_order_id")
    o = _norm_ids(_request("GET", "/fapi/v1/order", env, {"symbol": _canonical(symbol), **ident}))
    if "status" not in o:
        raise BinanceError("N/A", f"order query missing status: {o}", "order")
    return {
        "order_id": o["orderId"],
        "status": o["status"],
        "avg_price": float(o.get("avgPrice") or 0),
        "executed_qty": float(o.get("executedQty") or 0),
        "orig_qty": float(o.get("origQty") or 0),
        "client_order_id": o.get("clientOrderId") or "",
        "raw": o,
    }


TERMINAL_STATUSES = {"FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"}
ORDER_NOT_VISIBLE = -2013  # "Order does not exist."


def confirm_order(env, symbol, order_id, timeout=15):
    """Poll until the order reaches a terminal state. Returns get_order()'s
    dict plus 'commission' (summed from userTrades, best-effort — a stats
    lookup failing must not turn a FILLED order into an exception) once it is
    FILLED, or terminal with a partial fill (CANCELED / EXPIRED /
    EXPIRED_IN_MATCH after some executed_qty: the caller books what filled).
    Raises BinanceError if it ended with nothing filled, OrderNotConfirmed if
    no terminal state was read before timeout — the order MAY STILL FILL;
    re-query, do not blindly resubmit."""
    symbol = _canonical(symbol)
    deadline = time.time() + timeout
    order = None
    last_err = None
    while time.time() < deadline:
        try:
            order = get_order(env, symbol, order_id)
        except Exception as e:
            # The id came from the placement response, so every failure here — -2013
            # (the query side lagging the matching engine: measured live 0.18 s after a
            # market order that did fill), a read timeout, a dropped connection, a 5xx,
            # -1001 — leaves the order's fate unknown, never rejected.
            last_err = e
            time.sleep(1)
            continue
        if order["status"] == "FILLED":
            order["commission"], order["commission_asset"] = \
                _order_commission(env, symbol, order_id)
            return order
        if order["status"] in TERMINAL_STATUSES:
            if order["executed_qty"] > 0:
                order["commission"], order["commission_asset"] = \
                    _order_commission(env, symbol, order_id)
                return order
            raise BinanceError("N/A", f"order {order_id} ended {order['status']}", "confirm")
        time.sleep(1)
    if order is None:
        why = ("not queryable (-2013)" if isinstance(last_err, BinanceError)
               and last_err.code == ORDER_NOT_VISIBLE else
               f"not queryable ({type(last_err).__name__}: {str(last_err)[:80]})")
        raise OrderNotConfirmed(
            f"order {order_id} accepted but {why} for {timeout}s — "
            f"it may have filled; check the position, do not resubmit",
            venue="binance", venue_symbol=symbol, order_id=order_id)
    raise OrderNotConfirmed(
        f"order {order_id} still {order['status'] if order else 'UNKNOWN'} after {timeout}s",
        venue="binance", venue_symbol=symbol, order_id=order_id)


PARK_NOT_SENT_GRACE_S = 120


def resolve_unknown_order(env, symbol, order_id=None, client_order_id=None, parked_at=None,
                          now=None):
    """A parked order's outcome (lib/unconfirmed): (executed_qty, avg_price) once known —
    qty 0 = it ended, or never reached Binance, without a fill — None while unknown.
    Read-only: Query Order (by orderId, or origClientOrderId when only ours is known),
    cross-checked with userTrades.
    - terminal → its executed_qty / avgPrice;
    - not readable but userTrades for the orderId has fills → those (a market order fills
      at once);
    - only a client id, -2013 past PARK_NOT_SENT_GRACE_S and no trade on the symbol since
      shortly before the send → never reached the matching engine (Query Order finds every
      order younger than 3 days, filled or not — USD-M "Query Order" notes).
    Anything else (a key that cannot see the order, the venue down) stays unknown."""
    symbol = _canonical(symbol)
    now = time.time() if now is None else now
    order = None
    not_found = False
    try:
        order = get_order(env, symbol, order_id=order_id, client_order_id=client_order_id)
    except BinanceError as e:
        not_found = e.code == ORDER_NOT_VISIBLE
    except Exception:
        return None
    if order is not None:
        if order["status"] not in TERMINAL_STATUSES:
            return None
        qty, price = order["executed_qty"], order["avg_price"]
        return (qty, price) if qty <= 0 or price > 0 else None
    try:
        if order_id:
            fills = _request("GET", "/fapi/v1/userTrades", env,
                             {"symbol": symbol, "orderId": str(order_id)}) or []
            qty = sum(float(f.get("qty") or 0) for f in fills)
            if qty > 0:
                return qty, sum(float(f["qty"]) * float(f["price"]) for f in fills) / qty
            return None
        if not_found and parked_at and now - float(parked_at) >= PARK_NOT_SENT_GRACE_S:
            fills = _request("GET", "/fapi/v1/userTrades", env,
                             {"symbol": symbol, "startTime": int((float(parked_at) - 60) * 1000)}) or []
            return (0.0, 0.0) if not fills else None
    except Exception:
        return None
    return None


def _sum_by_asset(fills):
    out = {}
    for f in fills or []:
        a = str(f.get("commissionAsset") or "").upper()
        if a:
            out[a] = out.get(a, 0.0) + abs(float(f.get("commission") or 0))
    return out


def get_spot_fill_fees(env, symbol, order_id):
    """{ASSET: fee} over a spot order's fills (/api/v3/myTrades) — the spot
    order query carries no fee. Summed per commissionAsset: a BNB-discount
    account whose BNB runs out mid-order pays part in BNB, part in the coin.
    myTrades lags the fill by a moment: retried once. None when it can't be
    read (the caller falls back)."""
    for attempt in range(2):
        fills = _request("GET", "/api/v3/myTrades", env,
                         {"symbol": _canonical(symbol), "orderId": str(order_id)},
                         spot=True) or []
        if fills:
            return _sum_by_asset(fills)
        if attempt == 0:
            time.sleep(1)
    return None


def _order_commission(env, symbol, order_id):
    """(amount, asset) summed across the order's fills. NOT always USDT:
    fee-discount accounts pay in BNB (commissionAsset) — measured live, so the
    asset is returned rather than a number that would be silently mis-summed.
    userTrades lags the fill by a moment — retried once (measured: immediate
    query returned no fills, 1s later they were there). Best-effort: (0.0,
    'USDT') if the lookup fails — a stats hiccup must not fail a FILLED order.
    Mixed-asset fills (rare): sums the first asset seen and ignores others."""
    try:
        for attempt in range(2):
            fills = _request("GET", "/fapi/v1/userTrades", env,
                             {"symbol": symbol, "orderId": str(order_id)}) or []
            if fills:
                asset = fills[0].get("commissionAsset") or "USDT"
                return (sum(abs(float(f.get("commission") or 0)) for f in fills
                            if (f.get("commissionAsset") or "USDT") == asset), asset)
            if attempt == 0:
                time.sleep(1)
    except Exception:
        pass
    return (0.0, "USDT")


def _norm_open_row(o):
    """Open-order row contract (venue_wiring.sweep_orphan_orders): every row
    carries canonical 'symbol' + 'order_id' + 'client_order_id' alongside the
    venue's raw fields — the reconciler sweeps orphaned rc*-prefixed orders by
    these keys after a restart."""
    o = _norm_ids(o)
    o["symbol"] = _canonical(o.get("symbol"))
    o["order_id"] = o.get("orderId", "")
    o["client_order_id"] = o.get("clientOrderId") or ""
    return o


def get_open_orders(env, symbol=None):
    """All open REGULAR orders (market/limit), orderId normalized to str and
    each row normalized per _norm_open_row (symbol/order_id/client_order_id).
    Conditional SL/TP orders are NOT here — see get_open_algo_orders()."""
    params = {"symbol": _canonical(symbol)} if symbol else {}
    return [_norm_open_row(o) for o in
            (_request("GET", "/fapi/v1/openOrders", env, params) or [])]


def get_open_algo_orders(env, symbol=None):
    """All open CONDITIONAL (algo) orders — the Algo API keeps them separate
    from /fapi/v1/openOrders. algoId normalized to str. Response may arrive
    as a bare list or nested under 'orders' depending on doc version — both
    are handled."""
    params = {"symbol": _canonical(symbol)} if symbol else {}
    data = _request("GET", "/fapi/v1/openAlgoOrders", env, params) or []
    rows = data.get("orders", []) if isinstance(data, dict) else data
    return [_norm_ids(o) for o in rows]


def cancel_order(env, symbol, order_id=None, client_order_id=None):
    """Cancel one REGULAR order by orderId or the FULL newClientOrderId
    (prefix included — pass what get_order returned). Conditional orders go
    through cancel_algo_order.

    Idempotent-safe (chase-limit contract): an order that is already filled
    or gone rejects the cancel with -2011 CANCEL_REJECTED ("Unknown order
    sent") — that RETURNS {'status': 'already_gone', ...} instead of raising;
    the caller always re-reads fills afterwards. Other refusals raise."""
    params = {"symbol": _canonical(symbol)}
    if order_id:
        params["orderId"] = str(order_id)
    elif client_order_id:
        params["origClientOrderId"] = client_order_id
    else:
        raise ValueError("order_id or client_order_id required")
    try:
        return _norm_ids(_request("DELETE", "/fapi/v1/order", env, params))
    except BinanceError as e:
        if e.code == -2011:
            return {"status": "already_gone", "code": e.code, "msg": e.msg}
        raise


def cancel_algo_order(env, algo_id=None, client_algo_id=None):
    """Cancel one CONDITIONAL order by algoId or the FULL clientAlgoId."""
    params = {}
    if algo_id:
        params["algoId"] = str(algo_id)
    elif client_algo_id:
        params["clientAlgoId"] = client_algo_id
    else:
        raise ValueError("algo_id or client_algo_id required")
    return _norm_ids(_request("DELETE", "/fapi/v1/algoOrder", env, params))


def cancel_all_orders(env, symbol):
    """Cancel ALL open orders for a symbol — regular AND conditional (the two
    live on separate endpoints; cancelling only one side leaves protective
    orders behind). Only do this when also closing the position."""
    symbol = _canonical(symbol)
    out = {"orders": _request("DELETE", "/fapi/v1/allOpenOrders", env,
                              {"symbol": symbol})}
    out["algo_orders"] = _request("DELETE", "/fapi/v1/algoOpenOrders", env,
                                  {"symbol": symbol})
    return out


# ── protective orders ────────────────────────────────────────────────────────

def place_protective_orders(env, symbol, direction, qty=None, sl_price=None,
                            tp_price=None, verify=True, _after_entry=False):
    """Reduce-only STOP_MARKET / TAKE_PROFIT_MARKET for an EXISTING position,
    via the Algo Order API (/fapi/v1/order rejects conditional types with
    -4120 since the migration — measured live 2026-08-04).
    direction is the POSITION's direction; the orders take the opposite side.
    qty=None protects the WHOLE position via closePosition=true (survives
    size changes — prefer it unless doing partial TPs). Verifies the orders
    exist in open ALGO orders; raises ProtectionFailed otherwise — the caller
    MUST alert the user (naked position). Returned dicts carry algoId (str) —
    cancel via cancel_algo_order, not cancel_order."""
    symbol = _canonical(symbol)
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
                "algoType": "CONDITIONAL",
                "symbol": symbol,
                "side": close_side,
                "positionSide": _position_side(env, direction),
                "type": otype,
                # Algo API vocabulary: triggerPrice (the classic endpoint's
                # stopPrice name is not accepted here)
                "triggerPrice": format_price(env, symbol, trigger),
                "workingType": "MARK_PRICE",
                "clientAlgoId": _cid(),  # broker attribution rides this field
            }
            if qty is None:
                # closePosition carries its own reduce-only semantics and must
                # NOT be combined with quantity or reduceOnly
                params["closePosition"] = "true"
            else:
                params["quantity"] = format_qty(env, symbol, qty)
                if mode == "oneway":
                    params["reduceOnly"] = "true"
            order = _norm_ids(_request("POST", "/fapi/v1/algoOrder", env, params))
            if not order.get("algoId"):
                raise BinanceError("N/A", f"{otype} response missing algoId", "algoOrder")
            placed[kind] = order
    except guard.Halted as e:
        wanted = [k for k, p in (("sl", sl_price), ("tp", tp_price)) if p is not None]
        raise ProtectionFailed(
            guard.protection_halted_text(symbol, direction, wanted, placed, _after_entry) + f" {e}"
        ) from e
    except Exception as e:
        raise ProtectionFailed(
            f"{symbol} {direction} position may be NAKED — placing protective orders "
            f"failed after {list(placed)} succeeded: {e}"
        ) from e

    if verify and placed:
        open_ids = {o.get("algoId") for o in get_open_algo_orders(env, symbol)}
        missing = [k for k, o in placed.items() if o["algoId"] not in open_ids]
        if missing:
            raise ProtectionFailed(
                f"{symbol} {direction}: protective order(s) {missing} were accepted but "
                f"are NOT in open algo orders — verify manually, position may be naked"
            )
    return placed


# ── high-level entry / close ────────────────────────────────────────────────

def open_position(env, symbol, direction, qty, sl_price=None, tp_price=None,
                  client_order_id=None, confirm_timeout=15):
    """Open a position: confirmed market entry, then protective orders.
    Binance futures cannot attach SL/TP to the entry order itself (no atomic
    request like BingX's) — there IS a short naked window between the fill and
    the protective orders; this function makes it as small as one round-trip
    and raises ProtectionFailed if protection isn't verified on the exchange.

    Returns {'entry': confirmed order dict, 'protection': {'sl'/'tp': order}}.
    Returns False if qty is below the exchange minimum (skip semantics)."""
    symbol = _canonical(symbol)
    entry = place_market_order(
        env, symbol, direction, qty,
        client_order_id=client_order_id, confirm_timeout=confirm_timeout,
    )
    if entry is False:
        return False
    protection = {}
    if sl_price is not None or tp_price is not None:
        protection = place_protective_orders(
            env, symbol, direction, qty=None, sl_price=sl_price, tp_price=tp_price,
            _after_entry=True,
        )
    return {"entry": entry, "protection": protection}


def close_position(env, symbol, direction, qty, client_order_id=None):
    """Market-close (part of) an existing position, confirmed. direction is
    the POSITION being closed ('long'|'short')."""
    return place_market_order(
        env, symbol, direction, qty,
        client_order_id=client_order_id, reduce_only=True,
    )


def close_position_partial(env, symbol, direction, qty, client_order_id=None):
    """Cross-venue reconciler contract name — close_position already takes a
    qty (partial-capable); this alias is the FIXED name the reconciler and
    manager/flatten.py call."""
    return close_position(env, symbol, direction, qty, client_order_id=client_order_id)


# ── leverage ─────────────────────────────────────────────────────────────────

def set_leverage(env, symbol, leverage):
    """Set leverage (applies to both sides on Binance). Never silently
    inherit: query first, set only on user instruction (references/manager.md
    confirmation rules)."""
    return _request("POST", "/fapi/v1/leverage", env, {
        "symbol": _canonical(symbol), "leverage": str(int(leverage)),
    })


def get_mark_price(env, symbol):
    """Live mark price (public premiumIndex) — the cross-venue wiring contract
    for USD→qty conversion (lib/venue_wiring.py)."""
    data = _send("GET", "/fapi/v1/premiumIndex", env,
                 {"symbol": _canonical(symbol)}, signed=False)
    return float(data["markPrice"])


def get_bbo(env, symbol):
    """Top-of-book {'bid': float, 'ask': float} from the public bookTicker —
    real best bid/ask, never mark/last price (chase-limit contract)."""
    data = _send("GET", "/fapi/v1/ticker/bookTicker", env,
                 {"symbol": _canonical(symbol)}, signed=False)
    return {"bid": float(data["bidPrice"]), "ask": float(data["askPrice"])}


def get_leverage(env, symbol):
    """Current leverage for the symbol, from the position-risk row (present
    even when flat)."""
    rows = _request("GET", "/fapi/v2/positionRisk", env,
                    {"symbol": _canonical(symbol)}) or []
    lev = int(float(rows[0].get("leverage", 0))) if rows else 0
    return {"long": lev, "short": lev}


# ── spot execution (MARKET="spot" strategies) ────────────────────────────────
# Same guard/audit/attribution discipline as the futures layer, different
# vocabulary: spot broker prefix is x-GBN6HWR2, quantities obey the SPOT
# exchangeInfo filters (separate from futures rules), market BUYs can be
# placed in QUOTE currency (quoteOrderQty — no price conversion, no step
# math), and the FULL response returns fills inline: no confirm polling.
# There are no positions and no leverage — inventory is the position.

SPOT_BROKER_PREFIX = "x-GBN6HWR2"  # Blave spot broker ID — every spot order

_spot_rules_cache = {}  # symbol -> spot trading rules (per-process)


def _spot_cid(client_order_id=None):
    suffix = client_order_id or f"{int(time.time() * 1000):x}"
    cid = f"{SPOT_BROKER_PREFIX}{suffix}"
    if len(cid) > CID_MAX:
        raise ValueError(
            f"client_order_id too long: {len(suffix)} chars, max "
            f"{CID_MAX - len(SPOT_BROKER_PREFIX)} after the spot broker prefix"
        )
    return cid


def get_spot_rules(env, symbol):
    """Spot trading rules for one symbol: {'step': str, 'min_qty': float,
    'min_notional': float, 'price_tick': str, 'active': bool}. Spot's
    notional filter is named NOTIONAL on current symbols but MIN_NOTIONAL on
    older doc examples — accept both. Cached per process; queried per symbol
    (spot exchangeInfo for ALL symbols is a multi-MB payload, unlike fapi's)."""
    symbol = _canonical(symbol)
    if symbol not in _spot_rules_cache:
        info = _send("GET", "/api/v3/exchangeInfo", env,
                     {"symbol": symbol}, signed=False, spot=True)
        symbols = info.get("symbols") or []
        if not symbols:
            raise BinanceError("N/A", f"symbol {symbol} not in spot exchangeInfo",
                               "exchangeInfo", kind=reject_token.SYMBOL_UNAVAILABLE)
        s = symbols[0]
        filters = {f.get("filterType"): f for f in s.get("filters", [])}
        lot = filters.get("LOT_SIZE", {})
        notional = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}
        _spot_rules_cache[symbol] = {
            "step": lot.get("stepSize") or "1",
            "min_qty": float(lot.get("minQty", 0)),
            "min_notional": float(notional.get("minNotional", 0)),
            "price_tick": filters.get("PRICE_FILTER", {}).get("tickSize", "0.01"),
            "active": s.get("status") == "TRADING",
        }
    return _spot_rules_cache[symbol]


def format_spot_qty(env, symbol, qty):
    """Floor a BASE qty to the spot step. Raises ValueError below min_qty or
    on a suspended symbol. Plain decimal string."""
    rules = get_spot_rules(env, symbol)
    if not rules["active"]:
        raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE, f"{symbol} is not open for trading"))
    q = _floor_to_step(qty, rules["step"])
    if float(q) < rules["min_qty"] or float(q) <= 0:
        raise ValueError(reject_token.tag(reject_token.BELOW_MIN_SIZE,
            f"{symbol} spot qty {qty} floors to {q}, below minimum {rules['min_qty']}"
        ))
    return format(q, "f")


def format_spot_price(env, symbol, price):
    """Floor price to the spot symbol's tick size. Plain decimal string."""
    rules = get_spot_rules(env, symbol)
    return format(_floor_to_step(price, rules["price_tick"]), "f")


def place_spot_market_order(env, symbol, side, base_qty=None, quote_qty=None,
                            client_order_id=None):
    """Confirmed spot market order. side: 'buy'|'sell'.

    BUYs pass quote_qty (USDT amount — Binance's quoteOrderQty sizes the order
    in quote currency, no price conversion or step math on our side); SELLs
    pass base_qty (coin amount, floored to the spot step — you can only sell
    inventory you hold). Below min qty/notional → returns False (intentional
    skip, reconciler convention). Guard: buy=entry, sell=reduce.

    newOrderRespType=FULL makes the placement response itself carry the fills
    (spot fills synchronously) — status/avgPrice/executedQty/commission come
    from that response, no polling. Returns {'order_id', 'status',
    'avg_price', 'executed_qty', 'quote_qty', 'commission',
    'commission_asset', 'client_order_id', 'raw'}."""
    symbol = _canonical(symbol)
    side = side.lower()
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be buy|sell, got {side!r}")
    rules = get_spot_rules(env, symbol)
    params = {
        "symbol": symbol,
        "side": side.upper(),
        "type": "MARKET",
        "newOrderRespType": "FULL",
        "newClientOrderId": _spot_cid(client_order_id),
    }
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
            params["quantity"] = format_spot_qty(env, symbol, base_qty)
        except ValueError as e:
            if "not open for trading" in str(e):
                raise
            return False  # below min qty — intentional skip

    try:
        o = _norm_ids(_request("POST", "/api/v3/order", env, params, spot=True))
    except BinanceError as e:
        # -1013 = filter failure (NOTIONAL/LOT_SIZE) the pre-checks above
        # could not see (price moved) — the contract's intentional skip
        if e.code == -1013:
            return False
        raise
    status = o.get("status")
    executed = float(o.get("executedQty") or 0)
    quote = float(o.get("cummulativeQuoteQty") or 0)
    if status != "FILLED":
        raise BinanceError("N/A", f"spot order {o.get('orderId')} ended {status} "
                           f"(executed {executed})", "order")
    fills = o.get("fills") or []
    commission = 0.0
    commission_asset = None
    if fills:
        commission_asset = fills[0].get("commissionAsset")
        commission = sum(abs(float(f.get("commission") or 0)) for f in fills
                         if f.get("commissionAsset") == commission_asset)
    return {
        # every asset the fills paid in (BNB can run out mid-order: part BNB, part coin)
        "commissions": _sum_by_asset(fills),
        "order_id": o.get("orderId", ""),
        "status": status,
        "avg_price": (quote / executed) if executed else 0.0,
        "executed_qty": executed,
        "quote_qty": quote,
        "commission": commission,
        "commission_asset": commission_asset or "",
        "client_order_id": o.get("clientOrderId") or "",
        "raw": o,
    }


def get_spot_balances(env):
    """{asset: free+locked} for every non-zero spot balance — the spot
    inventory read the reconciler wiring keys `actual` on."""
    data = _send("GET", "/api/v3/account", env,
                 {"omitZeroBalances": "true"}, spot=True)
    out = {}
    for b in data.get("balances", []):
        amt = float(b.get("free") or 0) + float(b.get("locked") or 0)
        if amt > 0:
            out[b.get("asset")] = amt
    return out


def get_spot_price(env, symbol):
    """Last spot price (public)."""
    data = _send("GET", "/api/v3/ticker/price", env,
                 {"symbol": _canonical(symbol)}, signed=False, spot=True)
    return float(data["price"])


# ── spot limit layer (chase-limit contract, references/exchange-connect.md) ──

def place_spot_limit_order(env, symbol, side, base_qty, price,
                           client_order_id=None, post_only=False):
    """Spot limit order, UNCONFIRMED (it may rest) — track via get_spot_order.
    side: 'buy'|'sell'. base_qty is BASE currency on BOTH sides (unlike market
    buys, a limit has a price to convert with — no quoteOrderQty lane); price
    is floored to the spot tick here. Below min qty/notional → returns False
    (intentional skip). Returns a normalized dict with 'order_id' (+ status /
    orig_qty / executed_qty / avg_price / raw).

    post_only=True sends type LIMIT_MAKER — spot's post-only is an order TYPE,
    not a timeInForce, and LIMIT_MAKER takes quantity+price only. A maker
    order that would cross is refused with -2010 "Order would immediately
    match and take." and RETURNS {'status': 'post_only_rejected'} instead of
    raising; other -2010 messages (insufficient balance, …) stay fatal.
    Guard: buy=entry, sell=reduce."""
    symbol = _canonical(symbol)
    side = side.lower()
    if side not in ("buy", "sell"):
        raise ValueError(f"side must be buy|sell, got {side!r}")
    rules = get_spot_rules(env, symbol)
    try:
        qty_str = format_spot_qty(env, symbol, base_qty)
    except ValueError as e:
        # a suspended symbol is a FAULT, not an intentional min-size skip
        if "not open for trading" in str(e):
            raise
        return False
    price_str = format_spot_price(env, symbol, price)
    if float(qty_str) * float(price_str) < rules["min_notional"]:
        return False  # below min notional — intentional skip
    params = {
        "symbol": symbol,
        "side": side.upper(),
        "type": "LIMIT_MAKER" if post_only else "LIMIT",
        "quantity": qty_str,
        "price": price_str,
        "newClientOrderId": _spot_cid(client_order_id),
    }
    if not post_only:
        params["timeInForce"] = "GTC"  # LIMIT_MAKER rejects timeInForce
    try:
        o = _norm_ids(_request("POST", "/api/v3/order", env, params, spot=True))
    except BinanceError as e:
        if post_only and e.code == -2010 and "immediately match" in (e.msg or ""):
            return {"status": "post_only_rejected"}
        raise
    if not o.get("orderId"):
        raise BinanceError("N/A", f"spot order response missing orderId: {o}", "order")
    executed = float(o.get("executedQty") or 0)
    quote = float(o.get("cummulativeQuoteQty") or 0)
    return {
        "order_id": o["orderId"],
        "status": o.get("status") or "",
        "avg_price": (quote / executed) if executed else 0.0,
        "executed_qty": executed,
        "orig_qty": float(o.get("origQty") or 0),
        "client_order_id": o.get("clientOrderId") or "",
        "raw": o,
    }


def get_spot_order(env, symbol, order_id):
    """Spot order details by orderId. Normalized: status, avg_price,
    executed_qty, orig_qty, client_order_id, plus the raw dict under 'raw'.
    avg_price is derived from cummulativeQuoteQty/executedQty — the spot
    order query has no avgPrice field."""
    o = _norm_ids(_request("GET", "/api/v3/order", env,
                           {"symbol": _canonical(symbol), "orderId": str(order_id)},
                           spot=True))
    if "status" not in o:
        raise BinanceError("N/A", f"spot order query missing status: {o}", "order")
    executed = float(o.get("executedQty") or 0)
    quote = float(o.get("cummulativeQuoteQty") or 0)
    return {
        "order_id": o["orderId"],
        "status": o["status"],
        "avg_price": (quote / executed) if executed else 0.0,
        "executed_qty": executed,
        "orig_qty": float(o.get("origQty") or 0),
        "client_order_id": o.get("clientOrderId") or "",
        "raw": o,
    }


def cancel_spot_order(env, symbol, order_id=None, client_order_id=None):
    """Cancel one spot order by orderId or the FULL newClientOrderId.
    Idempotent-safe like cancel_order: already filled / gone rejects with
    -2011 CANCEL_REJECTED and RETURNS {'status': 'already_gone', ...} instead
    of raising — the caller re-reads fills afterwards."""
    params = {"symbol": _canonical(symbol)}
    if order_id:
        params["orderId"] = str(order_id)
    elif client_order_id:
        params["origClientOrderId"] = client_order_id
    else:
        raise ValueError("order_id or client_order_id required")
    try:
        return _norm_ids(_request("DELETE", "/api/v3/order", env, params, spot=True))
    except BinanceError as e:
        if e.code == -2011:
            return {"status": "already_gone", "code": e.code, "msg": e.msg}
        raise


def get_spot_bbo(env, symbol):
    """Spot top-of-book {'bid': float, 'ask': float} from the public
    bookTicker — real best bid/ask, never last price (chase-limit contract)."""
    data = _send("GET", "/api/v3/ticker/bookTicker", env,
                 {"symbol": _canonical(symbol)}, signed=False, spot=True)
    return {"bid": float(data["bidPrice"]), "ask": float(data["askPrice"])}


def get_spot_open_orders(env, symbol=None):
    """All open spot orders, each row normalized per _norm_open_row
    (canonical symbol / order_id / client_order_id — the reconciler's orphan
    sweep keys on these). Symbol omitted = all symbols (heavier call weight;
    used once at reconciler startup)."""
    params = {"symbol": _canonical(symbol)} if symbol else {}
    return [_norm_open_row(o) for o in
            (_request("GET", "/api/v3/openOrders", env, params, spot=True) or [])]


def sign_stock_agreement(env, *, user_consented):
    """Sign Binance's TradFi-Perps (stock perpetual) agreement for this account:
    signed POST /fapi/v1/stock/contract, no parameters; a success answers the bare
    text "SUCCESS" (measured 2026-10-20 on a live key). Neither the app nor the
    website shows a place to sign it, which is why a refused order (-4411,
    `stock_agreement`) points the user to the agent.

    This is the user's consent to an exchange agreement. Call it ONLY after the
    user said yes in the conversation — never on your own, and never as an
    automatic retry of a refused order. `user_consented=True` is that yes, said by the user;
    anything else raises before any request (tests/check_stock_perps: nothing under lib/,
    manager/ or runtime/ calls this)."""
    if user_consented is not True:
        raise PermissionError("sign_stock_agreement needs user_consented=True — ask the user first")
    got = _send("POST", "/fapi/v1/stock/contract", env, plain_text=True)
    if got != "SUCCESS":
        raise BinanceError("N/A", f"unexpected reply {str(got)[:120]!r}", "/fapi/v1/stock/contract")
    guard.audit("stock_agreement_signed", venue="binance", host=_base(env))
    return True
