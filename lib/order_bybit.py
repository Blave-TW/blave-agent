"""
Bybit order execution — USDT perpetual (linear) + spot, Unified Trading Account.

Ships implemented: NEVER hand-write Bybit order calls in a strategy, import from
here. Same contract and surface as lib/order_bingx.py — the four reconciler names
(get_contract_rules / format_qty / place_market_order / close_position_partial),
the limit layer, the spot layer, open_position with atomic SL/TP, and lib/guard
halt + audit built into the transport.

All functions take `env` (dotenv dict) first. `direction` is always the POSITION's
direction ('long' / 'short'); position mode (one-way vs hedge) is auto-detected.
BYBIT_DEMO=true routes every request to Bybit Demo Trading (api-demo.bybit.com,
demo keys).

Bybit facts, all measured live on a UTA account 2026-09-09:
- SL/TP are NATIVE and atomic — passed on /v5/order/create itself, no algo-order
  endpoint and no naked window.
- post-only that would cross is ACCEPTED then auto-cancelled with
  rejectReason EC_PostOnlyWillTakeLiquidity (OKX-style, not an error code).
- orderLinkId dedup is PERMANENT, not just the unfilled window: resending a
  FILLED id returns retCode 110072. The official docs only say the id "should be
  unique", so a linear market order POST that may have reached Bybit is still
  never sent again: it raises OrderNotConfirmed, which lib/unconfirmed parks and
  resolve_unknown_order looks up by orderLinkId.
- Hedge mode HARD-REJECTS an order with no positionIdx (retCode 10001).
- Spot lives inside the UNIFIED wallet (no separate spot account), spot buy fees
  are charged in the BASE coin, and both spot sides gate on minOrderAmt (value).
"""

import json
import os
import time
from decimal import ROUND_DOWN, Decimal

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
except ImportError:  # half-updated workspace: plain symbols, as before
    stock_perps = None

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)

LIVE_HOST = "https://api.bybit.com"
# Demo Trading, not testnet: keys come from the mainnet login and prices track
# the live book. It serves only a listed subset of v5 (no /v5/user/query-api,
# no FUND wallet, no deposit/withdraw history) — see lib/account_bybit.py.
DEMO_HOST = "https://api-demo.bybit.com"
RECV_WINDOW = "5000"  # Bybit's documented default; a late request retries once (_sync_time)
BROKER_REFERER = "Ue001036"  # broker attribution — MANDATORY on every request
TIMESTAMP_ERROR = 10002  # timestamp outside [server − recv_window, server + 1000)
# A linear market order POST answered with one of these may have executed (Bybit v5 error
# codes: 10000 "Server Timeout", 10016 "Server error" / "Service is restarting")
SEND_UNKNOWN_CODES = {10000, 10016}
_time_offset = {"ms": 0}  # Bybit's clock − ours, set by _sync_time

_RULES_CACHE = {}

# Bybit's own terminal vocabularies, normalized to the platform's words here so
# venue_wiring._norm_status never has to learn them. PartiallyFilledCanceled is
# the one that bites: it is TERMINAL but reads like an open partial, and a chase
# loop that treats it as open idles out its whole window.
_FILLED = {"filled"}
_GONE = {"cancelled", "canceled", "rejected", "deactivated",
         "partiallyfilledcanceled"}
# post-only that would have crossed: accepted, then killed with this reason
_POST_ONLY_REJECT = "ec_postonlywilltakeliquidity"
# cancel of an order that is already gone (filled/cancelled) OR never existed
_CANCEL_GONE_CODE = 110001


def _demo(env):
    return str(env.get("BYBIT_DEMO", os.environ.get("BYBIT_DEMO", ""))).lower() == "true"


def _host(env):
    return DEMO_HOST if _demo(env) else LIVE_HOST


def _now_ms():
    return int(time.time() * 1000) + _time_offset["ms"]


def _sync_time(env):
    """After a 10002: measure our clock against Bybit's (/v5/market/time, public)
    so the retry and every later request carry a timestamp it accepts. Measured
    on demo: a request that took 6.1 s to arrive (clock itself 0.1 s off) — the
    retry's fresh timestamp is what fixes that one. A failed read keeps the old
    offset; the retry still goes out."""
    try:
        t0 = time.time()
        r = requests.get(f"{_host(env)}/v5/market/time", headers={"referer": BROKER_REFERER},
                         timeout=5)
        t1 = time.time()
        server_ms = int(r.json()["result"]["timeNano"]) // 1_000_000
        _time_offset["ms"] = server_ms - int((t0 + t1) / 2 * 1000)
    except Exception:
        pass


class BybitError(Exception):
    """code = Bybit retCode and http_status = HTTP status, when known —
    lib/account_bybit.classify reads them."""

    def __init__(self, *args, code=None, http_status=None, kind=None):
        kind = kind or reject_token.from_code(code, _REJECT_CODES, reject_token.credential_codes("bybit"))
        if kind == _STOCK_AGREEMENT and args:
            # POST /v5/user/agreement (categoryV2 1) needs a transfer/withdraw-permission key and a
            # main account — Blave keys are trade-only, so no signing on the user's behalf here.
            args = (f"要先簽 Bybit 股票永續協議：請用主帳戶在 Bybit 網頁或 App 開這檔合約交易頁簽署（子帳戶不能簽），簽完下一輪自動再下（{args[0]}）",) + args[1:]
        super().__init__(*((reject_token.tag(kind, args[0]),) + args[1:] if args and kind else args))
        self.code = code
        self.http_status = http_status


# lib/reject_token kinds, from Bybit's v5 error page: 110004 / 110045 wallet balance and 110007 /
# 110012 available balance insufficient; 110017 "orderQty will be truncated to zero" (a reduce-only
# order larger than what is left). Rejected keys: account_bybit._CREDENTIAL.
# 110126 "You must sign the required agreement before trading this contract": measured on the demo
# account 2026-10-19/20 placing AMZNUSDT (a stock perp). Only the user signs it (in the app).
_STOCK_AGREEMENT = getattr(reject_token, "STOCK_AGREEMENT", "stock_agreement")
_REJECT_CODES = {"110126": _STOCK_AGREEMENT,
                 "110004": reject_token.INSUFFICIENT_MARGIN, "110007": reject_token.INSUFFICIENT_MARGIN,
                 "110012": reject_token.INSUFFICIENT_MARGIN, "110045": reject_token.INSUFFICIENT_MARGIN,
                 "110017": reject_token.REDUCE_ONLY_REJECTED}


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
    """An order Bybit took, or may have taken, whose outcome is not known: no usable
    answer to the POST, or no terminal state read before the confirm timeout. It may
    have filled — query it, never resubmit. A linear market order carries venue /
    venue_symbol (canonical) / order_id or orderLinkId so lib/portfolio can park it;
    a spot order carries no venue (not parkable: a spot market order HALTs)."""


class _SendUnknown(Exception):
    """A linear market order POST whose outcome is unknown; _request turns it into
    OrderNotConfirmed carrying the orderLinkId."""


class ProtectionFailed(Exception):
    """Entry filled but SL/TP is not visible — ALERT THE USER NOW."""


def _creds(env):
    api_key = env.get("BYBIT_API_KEY")
    # BYBIT_SECRET_KEY is what the platform writes (the {ID}_SECRET_KEY shape
    # used by the web bind and lib/venue.py). BYBIT_API_SECRET is the name the
    # published blave-quant-skill documented until 2026-09, so BYO-agent users
    # have it in their own .env — accept it rather than breaking them, same as
    # account_gateio.py accepts both GATEIO_* and GATE_*.
    secret = env.get("BYBIT_SECRET_KEY") or env.get("BYBIT_API_SECRET")
    if not api_key or not secret:
        raise ValueError("BYBIT_API_KEY / BYBIT_SECRET_KEY missing from .env")
    return api_key, secret


def _order_intent(method, path, body):
    """'entry' | 'reduce' | 'protective' | 'cancel' | None.

    Classified from the BODY, not the URL: HALT must block new exposure while
    letting every close, SL/TP and cancel through. A conditional order type
    alone is NOT protective — it must carry reduce semantics."""
    if method != "POST":
        return None
    p = body or {}
    if path in ("/v5/order/cancel", "/v5/order/cancel-all"):
        return "cancel"
    if path == "/v5/position/trading-stop":
        return "protective"
    if path == "/v5/order/create":
        if p.get("category") == "spot":
            # spot has no positions: BUY builds exposure, SELL liquidates
            return "reduce" if str(p.get("side", "")).lower() == "sell" else "entry"
        if p.get("reduceOnly"):
            return "reduce"
        return "entry"
    return None


_AUDIT_KEYS = ("category", "symbol", "side", "qty", "price", "orderType",
               "timeInForce", "reduceOnly", "positionIdx", "orderLinkId",
               "takeProfit", "stopLoss", "marketUnit")


def _request(env, method, path, params=None, body=None, retries=3):
    """Signed v5 request with guard gate + audit on order-mutating calls."""
    intent = _order_intent(method, path, body)
    if intent is None:
        return _send(env, method, path, params, body, retries)
    fields = {k: (body or {})[k] for k in _AUDIT_KEYS if k in (body or {})}
    fields["intent"] = intent
    guard.check_restart_stop(intent, fields)
    guard.check_account_hold("bybit", intent, fields)
    fields["demo"] = _demo(env)
    if intent == "entry" and guard.entry_blocked():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for "
            f"{fields.get('symbol')} refused before reaching the exchange. "
            f"Trading is paused: only cancels go out (closes on the user's explicit "
            f"close only). Only the user may clear the halt (guard.clear_halt)."
        )
    guard.audit("order_attempt", **fields)
    b = body or {}
    # linear market orders only: limit and spot POSTs keep the resend-with-orderLinkId transport
    placing = (path == "/v5/order/create" and b.get("category") == "linear"
               and b.get("orderType") == "Market")
    try:
        data = _send(env, method, path, params, body, retries, no_resend=placing)
    except _SendUnknown as e:
        cid = b.get("orderLinkId")
        guard.audit("order_unknown", error=str(e), client_order_id=cid, **fields)
        # one read-only look by orderLinkId: an order that landed goes on to the confirm poll
        # instead of a park; one not visible yet is parked — never sent again either way
        try:
            row = _find_order_row(env, "linear", {"orderLinkId": cid}, b.get("symbol")) if cid else None
        except Exception:
            row = None
        if row and row.get("orderId"):
            guard.audit("order_ok", order_id=str(row["orderId"]), found_by="orderLinkId", **fields)
            return {"orderId": row["orderId"], "orderLinkId": cid}
        err = OrderNotConfirmed(
            f"bybit order {cid} sent, no answer ({e}) — it may have filled; check the position, "
            f"do not resubmit", venue="bybit", venue_symbol=b.get("symbol"),
            client_order_id=cid)
        err.audited = True
        raise err from e
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise
    guard.audit("order_ok", order_id=str((data or {}).get("orderId") or ""), **fields)
    return data


def _never_sent(e):
    """A requests ConnectionError raised before any byte went out: the socket could not be
    opened (refused, unreachable, DNS — urllib3 NewConnectionError / NameResolutionError,
    wrapped in MaxRetryError). A TLS handshake timeout surfaces as ReadTimeout and cannot be
    told apart from a lost answer, so it stays unknown."""
    try:
        from urllib3.exceptions import NewConnectionError
    except ImportError:
        return False
    inner = e.args[0] if e.args else None
    return isinstance(getattr(inner, "reason", None), NewConnectionError) \
        or isinstance(inner, NewConnectionError)


def _send(env, method, path, params=None, body=None, retries=3, no_resend=False):
    """no_resend (linear market order POSTs): once the request may have reached Bybit it is
    never sent again — a dropped connection, a read timeout, a body cut mid-transfer, a 5xx,
    a 2xx that is not JSON or a SEND_UNKNOWN_CODES answer raises _SendUnknown. Only a connect
    timeout or a socket that never opened (refused, DNS), 10002 (refused at authentication,
    re-signed) and 10006 (rate limited) go out again — none of them can have executed."""
    api_key, secret = _creds(env)
    import hashlib
    import hmac
    last_err = None
    resynced = False
    for attempt in range(retries):
        ts = str(_now_ms())
        if method.upper() == "GET":
            payload = "&".join(f"{k}={v}" for k, v in (params or {}).items())
            url = f"{_host(env)}{path}" + (f"?{payload}" if payload else "")
            data = None
        else:
            payload = json.dumps(body or {}, separators=(",", ":"))
            url = f"{_host(env)}{path}"
            data = payload
        sign = hmac.new(secret.encode(),
                        (ts + api_key + RECV_WINDOW + payload).encode(),
                        hashlib.sha256).hexdigest()
        headers = {
            "X-BAPI-API-KEY": api_key,
            "X-BAPI-TIMESTAMP": ts,
            "X-BAPI-RECV-WINDOW": RECV_WINDOW,
            "X-BAPI-SIGN": sign,
            "referer": BROKER_REFERER,
            "Content-Type": "application/json",
        }
        try:
            r = requests.request(method.upper(), url, headers=headers,
                                 data=data, timeout=15)
        except (requests.exceptions.InvalidURL, requests.exceptions.MissingSchema,
                requests.exceptions.InvalidSchema, requests.exceptions.InvalidHeader):
            raise  # refused before anything was sent
        except requests.exceptions.ConnectionError as e:
            if no_resend and not isinstance(e, requests.exceptions.ConnectTimeout) \
                    and not _never_sent(e):
                raise _SendUnknown(f"{type(e).__name__}: {str(e)[:120]}") from e
            # A limit / spot POST whose response died may still have landed.
            # Bybit's orderLinkId dedup is permanent (110072 even after fill,
            # measured), so a resend carrying the same orderLinkId is answered
            # 110072 and resolved below rather than placed twice.
            if method.upper() == "POST" and not (body or {}).get("orderLinkId"):
                raise
            last_err = e
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt)
            continue
        except requests.exceptions.RequestException as e:
            # ReadTimeout / ChunkedEncodingError / ContentDecodingError are not
            # ConnectionError subclasses
            if no_resend:
                raise _SendUnknown(f"{type(e).__name__}: {str(e)[:120]}") from e
            raise
        if no_resend and r.status_code >= 500:
            raise _SendUnknown(f"HTTP {r.status_code}: {r.text[:120]}")
        r.raise_for_status()
        try:
            payload_json = r.json()
        except ValueError:
            if no_resend:
                raise _SendUnknown(f"HTTP {r.status_code} non-JSON ({r.text[:80]})")
            raise
        code = payload_json.get("retCode")
        if code == 0:
            return payload_json.get("result") or {}
        if no_resend and code in SEND_UNKNOWN_CODES:
            raise _SendUnknown(f"retCode={code}: {payload_json.get('retMsg')}")
        link_id = (body or {}).get("orderLinkId")
        if code == 110072 and attempt > 0 and link_id:
            # We only got here by retrying a POST whose connection died. A
            # duplicate orderLinkId therefore means the FIRST attempt actually
            # landed — raising would report a failure for an order that exists
            # (and may already have filled). Resolve it back to its orderId.
            found = _lookup_by_link_id(env, (body or {}).get("category", "linear"),
                                       link_id, (body or {}).get("symbol"))
            if found:
                return found
            if no_resend:
                # an order with this id exists and could not be read back: unknown, not 拒單
                raise _SendUnknown("retCode=110072 after a resend, lookup by orderLinkId failed")
        msg = str(payload_json.get("retMsg") or "")
        # 10004's message echoes the signed origin_string, which CONTAINS THE
        # API KEY — it reaches logs and the web connect-failure page.
        if api_key and api_key in msg:
            msg = msg.replace(api_key, "***")
        if code == TIMESTAMP_ERROR and not resynced and attempt < retries - 1:
            # rejected before it was processed — resending cannot double anything
            resynced = True
            _sync_time(env)
            last_err = BybitError(f"bybit {path} retCode={code}: {msg}",
                                  code=code, http_status=r.status_code)
            continue
        if code == 10006 and attempt < retries - 1:  # rate limited — back off
            time.sleep(1 + attempt * 2)
            last_err = BybitError(f"bybit {path} retCode={code}: {msg}",
                                  code=code, http_status=r.status_code)
            continue
        raise BybitError(f"bybit {path} retCode={code}: {msg}",
                         code=code, http_status=r.status_code)
    raise last_err


def _lookup_by_link_id(env, category, link_id, symbol=None):
    """Resolve an orderLinkId back to its order row (open first, then history).
    Used only to recover from a retried POST that turned out to have landed."""
    for path in ("/v5/order/realtime", "/v5/order/history"):
        try:
            rows = _send(env, "GET", path,
                         {"category": category, **({"symbol": symbol} if symbol else {}),
                          "orderLinkId": link_id},
                         retries=1).get("list") or []
        except Exception:
            continue
        if rows:
            return {"orderId": rows[0].get("orderId"), "orderLinkId": link_id}
    return None


def _public(env, path, params):
    r = requests.get(f"{_host(env)}{path}", params=params,
                     headers={"referer": BROKER_REFERER}, timeout=10)
    r.raise_for_status()
    body = r.json()
    if body.get("retCode") != 0:
        raise BybitError(f"bybit {path} retCode={body.get('retCode')}: {body.get('retMsg')}",
                         code=body.get("retCode"), http_status=r.status_code)
    return body.get("result") or {}


def _floor_str(value, step):
    """Floor `value` to a whole number of `step`, returned as the venue's own
    plain-decimal string.

    `step` MUST arrive as the ORIGINAL string from the instrument filter
    ('0.00001'), never as a float. float('0.00001') stringifies as '1e-05',
    whose decimal-place count reads as 0, which formats every price as '0' —
    and Bybit ACCEPTS stopLoss/takeProfit '0' silently, treating it as no
    protection at all (measured: an entry reported filled with an audit body
    carrying stopLoss '0' and came back naked). Decimal also avoids the binary
    float error that makes 6.0 / 0.1 = 59.999... drop a whole step."""
    s = Decimal(str(step))
    if s <= 0:
        return str(value)
    v = Decimal(str(value))
    floored = (v / s).to_integral_value(rounding=ROUND_DOWN) * s
    return format(floored.quantize(s), "f")


def _floor_to(value, step):
    """Numeric form of _floor_str, for min-size comparisons."""
    return float(_floor_str(value, step))


# --------------------------------------------------------------------------
# Reconciler's four fixed names
# --------------------------------------------------------------------------

def _linear_rows(env):
    from lib import account_bybit  # one fetch and one cache for both libs (retCode-checked)
    return account_bybit.linear_rows(env)


def _linear(env, symbol):
    """The Bybit name for a canonical symbol: itself, except a Binance US stock perp whose
    bare name a coin owns here (AMDUSDT → AMDSTOCKUSDT; lib/stock_perps)."""
    if stock_perps is None or stock_perps.binance_class(symbol) != stock_perps.STOCK:
        return symbol
    return stock_perps.venue_name("bybit", symbol, _linear_rows(env)) or symbol


def _canonical_symbol(env, venue_sym):
    """Bybit's linear name → the strategy's (AMDSTOCKUSDT → AMDUSDT). A Binance coin name
    is taken as is without reading Bybit's list."""
    if stock_perps is None or not venue_sym or stock_perps.binance_class(venue_sym) == "COIN":
        return venue_sym
    return stock_perps.canonical("bybit", venue_sym, _linear_rows(env))


def get_contract_rules(env: dict, symbol: str) -> dict:
    """Linear-perp rules for a CANONICAL symbol. Bybit symbols are already
    canonical ('BTCUSDT'), so there is no conversion. contract_value is 1:
    Bybit linear qty IS base units, never a contract count."""
    symbol = _linear(env, symbol)
    key = ("linear", symbol)
    if key not in _RULES_CACHE:
        rows = _public(env, "/v5/market/instruments-info",
                       {"category": "linear", "symbol": symbol}).get("list") or []
        if not rows:
            raise BybitError(f"bybit: unknown linear symbol {symbol}", kind=reject_token.SYMBOL_UNAVAILABLE)
        lot, price = rows[0]["lotSizeFilter"], rows[0]["priceFilter"]
        _RULES_CACHE[key] = {
            "step": str(lot["qtyStep"]),
            "min_qty": float(lot["minOrderQty"]),
            "min_notional": float(lot.get("minNotionalValue") or 0),
            "contract_value": 1.0,
            "tick": str(price["tickSize"]),
            "equity": (None if rows[0].get("symbolType") is None
                       else rows[0]["symbolType"] in ("stock", "ETF")),
        }
    return _RULES_CACHE[key]


def format_qty(env: dict, symbol: str, qty: float, price: float = None) -> str:
    """Floor a BASE qty to the step; empty string when it is below the venue
    minimum. MIN-SIZE GATE ONLY — never feed the result back into
    place_market_order (Bybit qty is base units, so it would be a no-op here,
    but the contract is shared across venues where it is not)."""
    rules = get_contract_rules(env, symbol)
    step = rules["step"]
    floored = _floor_to(abs(float(qty)), step)
    if floored < rules["min_qty"]:
        return ""
    if rules["min_notional"] and price and floored * float(price) < rules["min_notional"]:
        return ""
    return _floor_str(floored, step)


def _position_rows(env: dict, symbol: str) -> list:
    """One /v5/position/list read, reused for BOTH the position-mode decision
    and the mark price. NEVER cached: the user can flip one-way<->hedge in the
    Bybit app at any time, and a stale mode sends the wrong positionIdx — which
    is either a 10001 hard reject or, worse, an order that opens the OPPOSITE
    leg (the hedge-mode bug this contract exists to prevent)."""
    return _request(env, "GET", "/v5/position/list",
                    {"category": "linear", "symbol": _linear(env, symbol)}).get("list") or []


def _position_mode(rows) -> int:
    """0 = one-way, 3 = hedge. Hedge mode HARD-REJECTS an order carrying no
    positionIdx (retCode 10001 'position idx not match position mode')."""
    return 3 if {int(r.get("positionIdx") or 0) for r in rows} - {0} else 0


def _position_idx(rows, direction):
    """In hedge mode the index identifies the LEG: 1 = long, 2 = short. For a
    reduce order it must name the leg BEING CLOSED, not the order side — an
    order side alone would open the opposite leg."""
    if _position_mode(rows) == 0:
        return 0
    return 1 if direction == "long" else 2


def _mark_price(rows):
    for r in rows:
        px = float(r.get("markPrice") or 0)
        if px > 0:
            return px
    return 0.0


def _order_side(direction, reduce_only):
    if reduce_only:
        return "Sell" if direction == "long" else "Buy"
    return "Buy" if direction == "long" else "Sell"


def _confirm(env, symbol, order_id, category="linear", timeout=20):
    """Poll to a terminal state and report what the EXCHANGE says. Market
    orders split across several fills, so the aggregate on the order row
    (cumExecQty / avgPrice / cumExecFee) is the answer, not any single fill."""
    deadline = time.time() + timeout
    delay = 0.4
    last = None
    venue_sym = None
    while time.time() < deadline:
        try:
            if venue_sym is None:
                venue_sym = _linear(env, symbol) if category == "linear" else symbol
            row = _find_order_row(env, category, {"orderId": order_id}, venue_sym)
        except Exception as e:
            # the id came from the placement answer: a read timeout, a 5xx or a 10016 leave
            # its fate unknown, not rejected
            last = f"{type(e).__name__}: {str(e)[:80]}"
            row = None
        if row:
            status = str(row.get("orderStatus") or "").lower()
            if status in _FILLED or status in _GONE:
                return row
            last = status
        time.sleep(delay)
        delay = min(delay * 1.6, 2.0)  # back off — bursts return retCode 10006
    raise OrderNotConfirmed(
        f"bybit {symbol} order {order_id} not terminal in {timeout}s ({last or 'not found'}) — "
        f"it may have filled; check the position, do not resubmit",
        venue="bybit" if category == "linear" else None, venue_symbol=symbol, order_id=order_id)


def _find_order_row(env, category, ident, venue_symbol=None):
    """The order row for {'orderId': …} or {'orderLinkId': …}: /v5/order/realtime first
    (by id it also returns the account's last 500 closed orders — openOnly is ignored),
    then /v5/order/history (after a Bybit restart closed orders are only there; cancelled /
    rejected kept 24 h, filled 7 days). venue_symbol is Bybit's name: linear queries name
    one of symbol / baseCoin / settleCoin, and orderId > orderLinkId > symbol, so it cannot
    pick another order. None when neither lists it; a failed read raises."""
    sym = {"symbol": venue_symbol} if venue_symbol else {}
    for path in ("/v5/order/realtime", "/v5/order/history"):
        rows = _request(env, "GET", path, {"category": category, **sym, **ident}).get("list") or []
        if rows:
            return rows[0]
    return None


def _fills(row):
    qty = float(row.get("cumExecQty") or 0)
    avg = row.get("avgPrice")
    return {
        "avg_price": float(avg) if avg not in (None, "") else 0.0,
        "executed_qty": qty,
        "commission": float(row.get("cumExecFee") or 0),
        "order_id": row.get("orderId"),
    }


def place_market_order(env: dict, symbol: str, direction: str, qty: float,
                       client_order_id: str = None, reduce_only: bool = False):
    """Confirmed market order. qty is BASE currency. Returns exchange-reported
    fills, or False when the size is below the venue minimum (intentional skip,
    not an error — no phantom-trade notification)."""
    guard.arm_restore(symbol, direction, qty, reduce_only)  # HALT's one netted-restore pass
    rules = get_contract_rules(env, symbol)
    step = rules["step"]
    sized = _floor_to(abs(float(qty)), step)
    if sized < rules["min_qty"]:
        return False
    rows = _position_rows(env, symbol)
    if rules["min_notional"]:
        # markPrice off the row we already hold — a separate get_bbo call per
        # order is one more request per reconciler cycle against a rate limit
        # that already returns 10006 under load.
        px = _mark_price(rows) or ((lambda b: (b["bid"] + b["ask"]) / 2)(get_bbo(env, symbol)))
        if sized * px < rules["min_notional"]:
            return False
    body = {
        "category": "linear", "symbol": _linear(env, symbol),
        "side": _order_side(direction, reduce_only),
        "orderType": "Market", "qty": _floor_str(sized, step),
        "positionIdx": _position_idx(rows, direction),
    }
    if reduce_only:
        body["reduceOnly"] = True
    row = _market_and_confirm(env, symbol, body, client_order_id)
    status = str(row.get("orderStatus") or "").lower()
    if status in _GONE and float(row.get("cumExecQty") or 0) == 0:
        raise BybitError(
            f"bybit {symbol} market order {status}: "
            f"{row.get('rejectReason') or row.get('cancelType') or 'no reason given'}")
    return _fills(row)


def _market_and_confirm(env, symbol, body, client_order_id):
    """POST a linear market order and poll it to a terminal row. Always carries an
    orderLinkId: an order whose answer is lost is looked up by it (without one it could
    not be parked = HALT). OrderNotConfirmed leaves with the strategy's canonical symbol —
    the park is queried with it — not Bybit's AMDSTOCKUSDT."""
    # ≤36 chars of letters / digits / - / _ (Place Order, orderLinkId)
    body["orderLinkId"] = client_order_id or f"bl{int(time.time() * 1000):x}{os.urandom(3).hex()}"
    try:
        res = _request(env, "POST", "/v5/order/create", body=body)
        if not res.get("orderId"):
            # retCode 0 = Bybit took it; only the id is missing from the answer
            raise OrderNotConfirmed(
                f"bybit order {body['orderLinkId']} accepted without an orderId ({res}) — it may "
                f"have filled; check the position, do not resubmit", venue="bybit",
                client_order_id=body["orderLinkId"])
        return _confirm(env, symbol, res["orderId"])
    except OrderNotConfirmed as e:
        e.venue_symbol = symbol
        e.client_order_id = e.client_order_id or body["orderLinkId"]
        if not getattr(e, "audited", False):  # the POST path audits its own
            guard.audit("order_unknown", error=str(e), symbol=body.get("symbol"),
                        order_id=str(e.order_id or ""), client_order_id=e.client_order_id,
                        intent="reduce" if body.get("reduceOnly") else "entry")
        raise


def close_position_partial(env: dict, symbol: str, direction: str, qty: float,
                           client_order_id: str = None):
    """Reduce an existing position by a BASE qty, reduce-only. `direction` is
    the position BEING CLOSED. Under HALT only inside a close pass (lib/guard)."""
    return place_market_order(env, symbol, direction, qty,
                              client_order_id=client_order_id, reduce_only=True)


# --------------------------------------------------------------------------
# Entry with native protection
# --------------------------------------------------------------------------

def place_protective_orders(env: dict, symbol: str, direction: str,
                            sl_price: float = None, tp_price: float = None):
    """Attach/replace SL and TP on an OPEN position (whole position, Full mode).
    Prefer open_position() — attaching at entry leaves no naked window."""
    if sl_price is None and tp_price is None:
        raise ValueError("place_protective_orders needs sl_price and/or tp_price")
    tick = get_contract_rules(env, symbol)["tick"]
    body = {"category": "linear", "symbol": _linear(env, symbol), "tpslMode": "Full",
            "positionIdx": _position_idx(_position_rows(env, symbol), direction)}
    if sl_price is not None:
        body["stopLoss"] = _floor_str(sl_price, tick)
    if tp_price is not None:
        body["takeProfit"] = _floor_str(tp_price, tick)
    try:
        return _request(env, "POST", "/v5/position/trading-stop", body=body)
    except guard.Halted as e:
        wanted = [k for k, p in (("sl", sl_price), ("tp", tp_price)) if p is not None]
        raise ProtectionFailed(
            guard.protection_halted_text(symbol, direction, wanted, {}, False) + f" {e}"
        ) from e


def open_position(env: dict, symbol: str, direction: str, qty: float,
                  sl_price: float = None, tp_price: float = None,
                  client_order_id: str = None):
    """RECOMMENDED ENTRY FLOW: one atomic market order with SL/TP attached —
    Bybit accepts takeProfit/stopLoss on /v5/order/create itself, so there is
    no window where the position sits unprotected.

    Returns {'entry': <confirmed fills>, 'protection': [...]}. Raises
    ProtectionFailed if protection is not visible after the fill — treat that
    as an ALERT-THE-USER-NOW event, never swallow it."""
    rules = get_contract_rules(env, symbol)
    step = rules["step"]
    tick = rules["tick"]
    sized = _floor_to(abs(float(qty)), step)
    if sized < rules["min_qty"]:
        return False
    body = {
        "category": "linear", "symbol": _linear(env, symbol),
        "side": _order_side(direction, False), "orderType": "Market",
        "qty": _floor_str(sized, step), "tpslMode": "Full",
        "positionIdx": _position_idx(_position_rows(env, symbol), direction),
    }
    if sl_price is not None:
        body["stopLoss"] = _floor_str(sl_price, tick)
    if tp_price is not None:
        body["takeProfit"] = _floor_str(tp_price, tick)
    row = _market_and_confirm(env, symbol, body, client_order_id)
    if str(row.get("orderStatus") or "").lower() not in _FILLED:
        raise BybitError(f"bybit {symbol} entry not filled: "
                         f"{row.get('rejectReason') or row.get('orderStatus')}")
    entry = _fills(row)
    if sl_price is None and tp_price is None:
        return {"entry": entry, "protection": []}
    pos = _position_rows(env, symbol)
    idx = _position_idx(pos, direction)
    row = next((p for p in pos if int(p.get("positionIdx") or 0) == idx), {})
    got = {"stopLoss": row.get("stopLoss") or "", "takeProfit": row.get("takeProfit") or ""}
    if (sl_price is not None and not got["stopLoss"]) or \
       (tp_price is not None and not got["takeProfit"]):
        raise ProtectionFailed(
            f"bybit {symbol} {direction} filled {entry['executed_qty']} but "
            f"protection is missing (sl={got['stopLoss']!r} tp={got['takeProfit']!r}) "
            f"— the position is NAKED, act now")
    return {"entry": entry, "protection": [got]}


# --------------------------------------------------------------------------
# Limit layer (chase / TWAP)
# --------------------------------------------------------------------------

def get_bbo(env: dict, symbol: str) -> dict:
    """True best bid/ask — the ticker carries them directly; never substitute
    mark or last price."""
    t = (_public(env, "/v5/market/tickers",
                 {"category": "linear", "symbol": _linear(env, symbol)}).get("list") or [{}])[0]
    return {"bid": float(t["bid1Price"]), "ask": float(t["ask1Price"])}


def get_mark_price(env: dict, symbol: str) -> float:
    """Live mark price (public ticker) — the cross-venue wiring contract for
    USD→qty conversion (lib/venue_wiring.py) and for the min-slice floor in
    lib/execute._venue_min_slice_usd. Falls back to lastPrice: a ticker without
    markPrice must not read as 0, which would collapse the min-slice gate to
    the flat floor and re-open the abort/re-dispatch loop it exists to stop."""
    t = (_public(env, "/v5/market/tickers",
                 {"category": "linear", "symbol": _linear(env, symbol)}).get("list") or [{}])[0]
    return float(t.get("markPrice") or t.get("lastPrice"))


def get_spot_price(env: dict, symbol: str) -> float:
    """Last spot price (public)."""
    t = (_public(env, "/v5/market/tickers",
                 {"category": "spot", "symbol": symbol}).get("list") or [{}])[0]
    return float(t["lastPrice"])


def place_limit_order(env: dict, symbol: str, direction: str, qty: float,
                      price: float, client_order_id: str = None,
                      reduce_only: bool = False, time_in_force: str = "GTC",
                      post_only: bool = False):
    """Limit order. Returns {'order_id', 'status'} — or
    {'status': 'post_only_rejected'} when a post-only order would have crossed,
    or False below the venue minimum.

    Bybit ACCEPTS a crossing post-only order and then auto-cancels it with
    rejectReason EC_PostOnlyWillTakeLiquidity (measured) — there is no rejection
    at placement time, so the order must be read back before it can be called
    placed. The chase engine relies on this mapping to re-post."""
    rules = get_contract_rules(env, symbol)
    step, tick = rules["step"], rules["tick"]
    sized = _floor_to(abs(float(qty)), step)
    if sized < rules["min_qty"]:
        return False
    if rules["min_notional"] and sized * float(price) < rules["min_notional"]:
        return False
    body = {
        "category": "linear", "symbol": _linear(env, symbol),
        "side": _order_side(direction, reduce_only), "orderType": "Limit",
        "qty": _floor_str(sized, step), "price": _floor_str(price, tick),
        "timeInForce": "PostOnly" if post_only else time_in_force,
        "positionIdx": _position_idx(_position_rows(env, symbol), direction),
    }
    if reduce_only:
        body["reduceOnly"] = True
    if client_order_id:
        body["orderLinkId"] = client_order_id
    res = _request(env, "POST", "/v5/order/create", body=body)
    oid = res["orderId"]
    if post_only:
        rows = (_request(env, "GET", "/v5/order/realtime",
                         {"category": "linear", "orderId": oid}).get("list") or [])
        if not rows:
            rows = (_request(env, "GET", "/v5/order/history",
                             {"category": "linear", "orderId": oid}).get("list") or [])
        row = rows[0] if rows else {}
        if str(row.get("rejectReason") or "").lower() == _POST_ONLY_REJECT:
            return {"status": "post_only_rejected", "order_id": oid}
    return {"order_id": oid, "status": "open"}


def get_order(env: dict, symbol: str, order_id: str) -> dict:
    """{'status', 'orig_qty', 'executed_qty', 'avg_price'} with the status
    already in the platform's vocabulary. PartiallyFilledCanceled is mapped to
    'canceled': it is terminal, and reading it as open idles out a chase."""
    rows = (_request(env, "GET", "/v5/order/realtime",
                     {"category": "linear", "orderId": order_id}).get("list") or [])
    if not rows:
        rows = (_request(env, "GET", "/v5/order/history",
                         {"category": "linear", "orderId": order_id}).get("list") or [])
    if not rows:
        return {"status": "canceled", "orig_qty": 0.0, "executed_qty": 0.0,
                "avg_price": 0.0}
    row = rows[0]
    raw = str(row.get("orderStatus") or "").lower()
    status = "filled" if raw in _FILLED else ("canceled" if raw in _GONE else "open")
    avg = row.get("avgPrice")
    return {
        "status": status,
        "orig_qty": float(row.get("qty") or 0),
        "executed_qty": float(row.get("cumExecQty") or 0),
        "avg_price": float(avg) if avg not in (None, "") else 0.0,
    }


# fills are searched from PARK_TRADE_LOOKBACK_S before the park to PARK_TRADE_LOOKAHEAD_S after
# it. Demo 2026-10-30: when orderId/orderLinkId is given, execution/list ignores startTime/endTime,
# so the id does the filtering and the window only bounds the id-less case (100 rows per page)
PARK_TRADE_LOOKBACK_S = 300
PARK_TRADE_LOOKAHEAD_S = 600


def resolve_unknown_order(env, symbol, order_id=None, client_order_id=None, parked_at=None,
                          now=None):
    """A parked linear market order's outcome (lib/unconfirmed): (executed_qty, avg_price) in
    BASE units once it is terminal — qty 0 = it ended without a fill — None while unknown.
    Read-only: the order row by orderId, or by orderLinkId when only ours is known
    (realtime, then history); when neither lists it, the executions around the park
    (/v5/execution/list, filtered by that id) — any → those, at their VWAP. An order neither
    finds stays unknown however long ago it was parked: what Bybit answers for an
    orderLinkId that never arrived is unmeasured, and releasing an order that did fill is
    the duplicate this exists to prevent (the way out is unconfirmed.resolve)."""
    if not order_id and not client_order_id:
        return None
    ident = {"orderId": str(order_id)} if order_id else {"orderLinkId": str(client_order_id)}
    try:
        row = _find_order_row(env, "linear", ident, _linear(env, symbol))
    except Exception:
        return None
    if row is None:
        return _executions_of(env, symbol, ident, parked_at)
    status = str(row.get("orderStatus") or "").lower()
    if status not in _FILLED and status not in _GONE:
        return None
    qty = float(row.get("cumExecQty") or 0)
    avg = row.get("avgPrice")
    price = float(avg) if avg not in (None, "") else 0.0
    return (qty, price) if qty <= 0 or price > 0 else None


def _executions_of(env, symbol, ident, parked_at):
    if not parked_at:
        return None
    try:
        start = int((float(parked_at) - PARK_TRADE_LOOKBACK_S) * 1000) + int(_time_offset["ms"])
        end = int((float(parked_at) + PARK_TRADE_LOOKAHEAD_S) * 1000) + int(_time_offset["ms"])
        rows = _request(env, "GET", "/v5/execution/list",
                        {"category": "linear", "symbol": _linear(env, symbol), **ident,
                         "startTime": start, "endTime": end, "limit": 100}).get("list") or []
    except Exception:
        return None
    key, want = next(iter(ident.items()))
    mine = [x for x in rows if str(x.get(key) or "") == want
            and str(x.get("execType") or "Trade") != "Funding"]
    qty = sum(abs(float(x.get("execQty") or 0)) for x in mine)
    if qty <= 0:
        return None
    px = sum(abs(float(x.get("execQty") or 0)) * float(x.get("execPrice") or 0) for x in mine) / qty
    return (qty, px) if px > 0 else None


def cancel_order(env: dict, symbol: str, order_id: str = None,
                 client_order_id: str = None):
    """Cancel by id. An already-filled / already-cancelled / never-existed order
    returns a status instead of raising (Bybit reports all three as retCode
    110001) — the chase engine treats that as confirmation the order is dead.
    An accepted cancel returns 'cancel_accepted', not 'canceled'."""
    body = {"category": "linear", "symbol": _linear(env, symbol)}
    if order_id:
        body["orderId"] = order_id
    elif client_order_id:
        body["orderLinkId"] = client_order_id
    else:
        raise ValueError("cancel_order needs order_id or client_order_id")
    try:
        res = _request(env, "POST", "/v5/order/cancel", body=body)
    except BybitError as e:
        if f"retCode={_CANCEL_GONE_CODE}" in str(e):
            return {"status": "order_not_found", "order_id": order_id}
        raise
    # Bybit's cancel is asynchronous — the ack is not the order's end state (a fill can
    # still land), so this is not a status lib.execute's chase trusts as terminal: it
    # confirms through get_order
    return {"status": "cancel_accepted", "order_id": res.get("orderId") or order_id}


def cancel_all_orders(env: dict, symbol: str):
    """Cancel EVERY open linear order on the symbol — active, conditional,
    TP/SL and trailing stop (no orderFilter: Bybit's cancel-all then covers
    all kinds). Strips the position's protection: only when also closing it."""
    return _request(env, "POST", "/v5/order/cancel-all",
                    body={"category": "linear", "symbol": _linear(env, symbol)})


def get_open_algo_orders(env: dict, symbol: str) -> list:
    """The conditional rows get_open_orders deliberately hides (stopOrderType
    set: position TP/SL, stop, trailing) — for close/cleanup checks, never the
    orphan sweep. One page of 50; a symbol with more is not a real case."""
    params = {"category": "linear", "symbol": _linear(env, symbol), "limit": 50}
    rows = _request(env, "GET", "/v5/order/realtime", params).get("list") or []
    return [{
        "order_id": r.get("orderId"),
        "symbol": _canonical_symbol(env, r.get("symbol")),
        "side": r.get("side"),
        "stop_order_type": r.get("stopOrderType"),
        "trigger_price": float(r.get("triggerPrice") or 0),
    } for r in rows if r.get("stopOrderType") or ""]


def get_open_orders(env: dict, symbol: str = None) -> list:
    """Open orders for the orphan-order sweep.

    EXCLUDES the position's own SL/TP: Bybit lists those as open conditional
    orders (reduceOnly, stopOrderType TakeProfit / StopLoss), and a sweep that
    cancels them strips the position's protection.

    LINEAR ONLY, deliberately: the orphan sweep runs on the perp side, and spot
    has no position to protect. If a spot sweep is ever added it needs the same
    stopOrderType filter with category='spot' — do not reuse this one by
    swapping the category and calling it done."""
    params = {"category": "linear"}
    if symbol:
        params["symbol"] = _linear(env, symbol)
    else:
        params["settleCoin"] = "USDT"
    rows = _request(env, "GET", "/v5/order/realtime", params).get("list") or []
    return [{
        "order_id": r.get("orderId"),
        "client_order_id": r.get("orderLinkId"),
        "symbol": _canonical_symbol(env, r.get("symbol")),
        "side": r.get("side"),
        "qty": float(r.get("qty") or 0),
        "price": float(r.get("price") or 0),
        "reduce_only": bool(r.get("reduceOnly")),
    } for r in rows if not (r.get("stopOrderType") or "")]


# --------------------------------------------------------------------------
# Spot layer (strategies declaring MARKET = "spot")
# --------------------------------------------------------------------------

def get_spot_rules(env: dict, symbol: str) -> dict:
    """Spot filters are a DIFFERENT SHAPE from linear: base step is
    `basePrecision` (not qtyStep) and the minimum is `minOrderAmt`, a QUOTE
    value that gates BOTH sides (measured: selling 1 DOGE ~0.09 USDT is
    rejected with retCode 170140)."""
    key = ("spot", symbol)
    if key not in _RULES_CACHE:
        rows = _public(env, "/v5/market/instruments-info",
                       {"category": "spot", "symbol": symbol}).get("list") or []
        if not rows:
            raise BybitError(f"bybit: unknown spot symbol {symbol}", kind=reject_token.SYMBOL_UNAVAILABLE)
        lot, price = rows[0]["lotSizeFilter"], rows[0]["priceFilter"]
        _RULES_CACHE[key] = {
            "step": str(lot["basePrecision"]),
            "min_qty": float(lot["minOrderQty"]),
            "min_amt": float(lot.get("minOrderAmt") or 0),
            "tick": str(price["tickSize"]),
        }
    return _RULES_CACHE[key]


def format_spot_qty(env: dict, symbol: str, qty: float) -> str:
    rules = get_spot_rules(env, symbol)
    step = rules["step"]
    floored = _floor_to(abs(float(qty)), step)
    return "" if floored < rules["min_qty"] else _floor_str(floored, step)


def get_spot_bbo(env: dict, symbol: str) -> dict:
    t = (_public(env, "/v5/market/tickers",
                 {"category": "spot", "symbol": symbol}).get("list") or [{}])[0]
    return {"bid": float(t["bid1Price"]), "ask": float(t["ask1Price"])}


def get_spot_balances(env: dict) -> dict:
    """{ASSET: free qty}. On a UTA account there is NO separate spot wallet —
    spot inventory is the UNIFIED coin array and doubles as margin."""
    rows = _request(env, "GET", "/v5/account/wallet-balance",
                    {"accountType": "UNIFIED"}).get("list") or []
    out = {}
    for c in (rows[0].get("coin") if rows else []) or []:
        amount = float(c.get("walletBalance") or 0)
        if amount:
            out[(c.get("coin") or "").upper()] = amount
    return out


def place_spot_market_order(env: dict, symbol: str, side: str,
                            base_qty: float = None, quote_qty: float = None,
                            client_order_id: str = None):
    """Spot market order. BUYs are sized in QUOTE currency (marketUnit
    quoteCoin — the USD amount goes straight in, no price conversion); SELLs in
    base qty floored to basePrecision. Below minOrderAmt → False.

    Guard: buy = entry, sell = reduce (HALT blocks both outside a close pass).

    The buy fee is charged in the BASE coin (measured: a 6 USDT buy reported
    cumExecQty 66.3 DOGE and credited 66.2337), so the sellable amount is always
    a little under the reported fill — size sells from the WALLET, not from the
    buy's cumExecQty."""
    side = side.lower()
    rules = get_spot_rules(env, symbol)
    body = {"category": "spot", "symbol": symbol,
            "side": "Buy" if side == "buy" else "Sell", "orderType": "Market"}
    if side == "buy":
        if not quote_qty:
            raise ValueError("spot BUY must be sized in quote_qty")
        if float(quote_qty) < rules["min_amt"]:
            return False
        body["qty"] = f"{float(quote_qty):.2f}"
        body["marketUnit"] = "quoteCoin"
    else:
        if not base_qty:
            raise ValueError("spot SELL must be sized in base_qty")
        sized = format_spot_qty(env, symbol, base_qty)
        if not sized:
            return False
        if rules["min_amt"] and float(sized) * get_spot_bbo(env, symbol)["bid"] < rules["min_amt"]:
            return False
        body["qty"] = sized
        body["marketUnit"] = "baseCoin"
    if client_order_id:
        body["orderLinkId"] = client_order_id
    res = _request(env, "POST", "/v5/order/create", body=body)
    row = _confirm(env, symbol, res["orderId"], category="spot")
    if str(row.get("orderStatus") or "").lower() in _GONE and \
            float(row.get("cumExecQty") or 0) == 0:
        raise BybitError(f"bybit spot {symbol} {side} rejected: "
                         f"{row.get('rejectReason') or row.get('orderStatus')}")
    return _fills(row)


def place_spot_limit_order(env: dict, symbol: str, side: str, base_qty: float,
                           price: float, client_order_id: str = None,
                           post_only: bool = False, time_in_force: str = "GTC"):
    rules = get_spot_rules(env, symbol)
    sized = format_spot_qty(env, symbol, base_qty)
    if not sized:
        return False
    if rules["min_amt"] and float(sized) * float(price) < rules["min_amt"]:
        return False
    body = {"category": "spot", "symbol": symbol,
            "side": "Buy" if side.lower() == "buy" else "Sell",
            "orderType": "Limit", "qty": sized,
            "price": _floor_str(price, rules["tick"]),
            "timeInForce": "PostOnly" if post_only else time_in_force}
    if client_order_id:
        body["orderLinkId"] = client_order_id
    res = _request(env, "POST", "/v5/order/create", body=body)
    oid = res["orderId"]
    if post_only:
        rows = (_request(env, "GET", "/v5/order/realtime",
                         {"category": "spot", "orderId": oid}).get("list") or [])
        if not rows:
            rows = (_request(env, "GET", "/v5/order/history",
                             {"category": "spot", "orderId": oid}).get("list") or [])
        if rows and str(rows[0].get("rejectReason") or "").lower() == _POST_ONLY_REJECT:
            return {"status": "post_only_rejected", "order_id": oid}
    return {"order_id": oid, "status": "open"}


def get_spot_order(env: dict, symbol: str, order_id: str) -> dict:
    rows = (_request(env, "GET", "/v5/order/realtime",
                     {"category": "spot", "orderId": order_id}).get("list") or [])
    if not rows:
        rows = (_request(env, "GET", "/v5/order/history",
                         {"category": "spot", "orderId": order_id}).get("list") or [])
    if not rows:
        return {"status": "canceled", "orig_qty": 0.0, "executed_qty": 0.0,
                "avg_price": 0.0}
    row = rows[0]
    raw = str(row.get("orderStatus") or "").lower()
    status = "filled" if raw in _FILLED else ("canceled" if raw in _GONE else "open")
    avg = row.get("avgPrice")
    return {
        "status": status,
        "orig_qty": float(row.get("qty") or 0),
        "executed_qty": float(row.get("cumExecQty") or 0),
        "avg_price": float(avg) if avg not in (None, "") else 0.0,
        # the order's fee (a spot buy's is the base coin — place_spot_market_order)
        "commission": float(row.get("cumExecFee") or 0),
    }


def cancel_spot_order(env: dict, symbol: str, order_id: str = None,
                      client_order_id: str = None):
    body = {"category": "spot", "symbol": symbol}
    if order_id:
        body["orderId"] = order_id
    elif client_order_id:
        body["orderLinkId"] = client_order_id
    else:
        raise ValueError("cancel_spot_order needs order_id or client_order_id")
    try:
        res = _request(env, "POST", "/v5/order/cancel", body=body)
    except BybitError as e:
        if f"retCode={_CANCEL_GONE_CODE}" in str(e):
            return {"status": "order_not_found", "order_id": order_id}
        raise
    return {"status": "cancel_accepted", "order_id": res.get("orderId") or order_id}
