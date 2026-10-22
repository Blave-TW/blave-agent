"""
Bitget order execution — USDT-M perpetuals (coins, US stock perps (isRwa) and the
eight Taiwan stock perps) on a UTA (v3 API, the main path) or a classic account
(v2 API, not live-verified). Every call picks the API by
lib/account_bitget.account_mode(); a request that meets a mode change is never
re-sent to the other API — it raises MODE_SWITCH (TRANSIENT), and entries stay
refused for account_bitget.SWITCH_HOLD_S after it.

Companion to lib/account_bitget.py (credentials, signing, contract list, error
table, mode). NEVER hand-write Bitget order calls; import from here.

LAYERS SHIPPED HERE: the reconciler's four fixed names, get_mark_price,
get_position_mode, session_open; the limit layer (place_limit_order / get_bbo /
get_order / cancel_order / get_open_orders); SL/TP (place_protective_orders /
open_position / cancel_protective_orders, sweep_orphan_stops). Not here: spot.

NOT YET MEASURED ON A LIVE KEY: every fact below comes from Bitget's docs and the
requests / replies ccxt's bitget.py records; tests/live_bitget_verify.py turns them
into measurements (venue-onboarding §3). Only the account types in
account_bitget.VERIFIED_MODES (lib/venue_traits' bitget row) trade; empty = nothing is
signed, nothing is sent.

Broker attribution: none yet — account_bitget.BROKER_CHANNEL_CODE is empty until
Wei has Blave's channel code from Bitget; every request then carries it.

THE SIDE TABLE (the one place a mistake opens the opposite position). `side` means
the LEG on classic hedge but the ORDER DIRECTION on UTA hedge:
                  classic v2                       UTA v3
  hedge open L    side buy  + tradeSide open       side buy  + posSide long
  hedge close L   side buy  + tradeSide close      side sell + posSide long (+ reduceOnly yes)
  hedge open S    side sell + tradeSide open       side sell + posSide short
  hedge close S   side sell + tradeSide close      side buy  + posSide short (+ reduceOnly yes)
  one-way open    side = direction                 side = direction
  one-way close   opposite side + reduceOnly YES   opposite side + reduceOnly yes
(v2: Bitget's Place-Order doc; v3: the UTA Place-Order and Strategy docs, and ccxt's
create_uta_order_request.) UTA hedge closes also carry reduceOnly yes — not required
by the doc, a server-side refusal if the table above were ever wrong (T3U measures
that Bitget accepts it; UTA_HEDGE_REDUCE_ONLY switches it off if not).

Other facts this lib relies on:
- size / qty is BASE coin; sizeMultiplier is the step, minTradeNum the minimum, and
  minTradeUSDT (5) the minimum order value (public v2 contracts, read in either mode).
- position mode is account-wide (classic posMode, UTA holdMode), margin mode per
  symbol; both are read before every order, never cached — a stale mode is a reject
  or an order on the wrong leg.
- a reduce-only order's reply may carry no orderId (doc) — it is found by clientOid.
- stop-loss / take-profit trigger on the mark price: the Taiwan perps' books are thin,
  a last-trade trigger would fire on one print. Classic: position TP/SL (pos_loss /
  pos_profit); UTA: a `tpsl` strategy order in `full` mode, one per kind.
"""

import json
import logging
import re
import time
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal

import requests

from lib import guard
from lib import account_bitget as acct
from lib.account_bitget import CATEGORY, MARGIN_COIN, PRODUCT, BitgetError
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

ORDER_PATH = "/api/v2/mix/order/place-order"
CANCEL_PATH = "/api/v2/mix/order/cancel-order"
TPSL_PATH = "/api/v2/mix/order/place-tpsl-order"
CANCEL_PLAN_PATH = "/api/v2/mix/order/cancel-plan-order"
DETAIL_PATH = "/api/v2/mix/order/detail"
V3_ORDER_PATH = "/api/v3/trade/place-order"
V3_CANCEL_PATH = "/api/v3/trade/cancel-order"
V3_DETAIL_PATH = "/api/v3/trade/order-info"
V3_STRATEGY_PATH = "/api/v3/trade/place-strategy-order"
V3_CANCEL_STRATEGY_PATH = "/api/v3/trade/cancel-strategy-order"
UTA_HEDGE_REDUCE_ONLY = True

RULES_TTL_S = 600  # symbolStatus moves (limit_open / restrictedAPI): not an hour-old read
BELOW_MIN = {"45110", "43027"}  # classic / UTA: order value under the minimum → quiet False
UNKNOWN_SYMBOL = "40034"  # "Parameter NOPEUSDT does not exist" — public contracts, measured 2026-10-20
# order gone / never existed — replies ccxt records; T7 of the live script measures them
_CANCEL_GONE = {"40768", "43001", "40109"}  # classic cancel: 43001 measured live (R9, 2026-10-22)
# UTA order-info: the ONLY answers that mean "no such order" — 40109 (ccxt-recorded, the
# v2 not-found), ORDER_ABSENT (success with no order in it). R9U measures the v3 code.
ORDER_ABSENT = "order_absent"
_V3_ORDER_GONE = {"40109", ORDER_ABSENT}
_PLAN_GONE = {"43025"}
UNVERIFIED = acct.UNVERIFIED
# the order may have landed — query by clientOid (UTA Place-Order doc names the first three);
# 25212 duplicate clientOid (UTA error page): an earlier send of this very order landed
_UNCERTAIN = {"40725", "45001", "40010", "25212"}

_FILLED = {"filled", "full_fill"}
_GONE = {"canceled", "cancelled", "cancel"}
_OPEN_V3 = {"live", "new", "partially_filled"}
# Bitget allows . : / too, but the signature is over the un-encoded query and urlencode would
# encode : and / (40009 → a key error → HALT): only characters that survive encoding
_CID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
_rules_cache = {}


class OrderNotConfirmed(Exception):
    """Placed but not terminal within the timeout — it may still fill.
    Re-query by clientOid; NEVER blindly resubmit."""


class ProtectionFailed(Exception):
    """The position is OPEN but a stop-loss / take-profit could not be placed
    or verified — it may be NAKED. Alert the user."""


# ── symbols ──────────────────────────────────────────────────────────────────

def venue_symbol(symbol):
    """Canonical BASEUSDT → Bitget's contract name: itself, except a Binance US stock
    perp whose bare name a coin owns here (ACNUSDT → ACNSTOCKUSDT; lib/stock_perps)."""
    s = str(symbol or "").upper().replace("-", "").replace("_", "").replace("/", "")
    if not s.endswith("USDT") or len(s) <= 4:
        raise ValueError(reject_token.tag(reject_token.SYMBOL_UNAVAILABLE,
                                          f"cannot derive a Bitget USDT contract from {symbol!r}"))
    if stock_perps is None or stock_perps.binance_class(s) != stock_perps.STOCK:
        return s
    return stock_perps.venue_name("bitget", s, acct.contract_rows()) or s


canonical_symbol = acct.canonical


# ── transport ────────────────────────────────────────────────────────────────

def _order_intent(method, path, body):
    """'entry' | 'reduce' | 'protective' | 'cancel' | None, from the BODY: a
    tradeSide close (classic hedge), reduceOnly yes (one-way, either API) or a UTA
    side opposite to its posSide (UTA hedge) reduces; anything else on a
    place-order builds exposure."""
    if method != "POST":
        return None
    if path in (CANCEL_PATH, CANCEL_PLAN_PATH, V3_CANCEL_PATH, V3_CANCEL_STRATEGY_PATH):
        return "cancel"
    if path in (TPSL_PATH, V3_STRATEGY_PATH):
        return "protective"
    b = body or {}
    if path == ORDER_PATH:
        closes = (str(b.get("tradeSide", "")).lower() == "close"
                  or str(b.get("reduceOnly", "")).upper() == "YES")
        return "reduce" if closes else "entry"
    if path == V3_ORDER_PATH:
        side, pos = str(b.get("side", "")).lower(), str(b.get("posSide", "")).lower()
        closes = (str(b.get("reduceOnly", "")).lower() == "yes"
                  or (pos == "long" and side == "sell") or (pos == "short" and side == "buy"))
        return "reduce" if closes else "entry"
    return None


_AUDIT_KEYS = ("symbol", "side", "tradeSide", "posSide", "reduceOnly", "orderType", "size", "qty",
               "price", "force", "timeInForce", "clientOid", "planType", "triggerPrice", "holdSide",
               "type", "stopLoss", "takeProfit", "orderId")


def _request(method, path, env, params=None, retries=3):
    """Signed request with the guard gate + audit on order-mutating calls.
    `params` = the query (GET) or the JSON body (POST)."""
    method = method.upper()
    intent = _order_intent(method, path, params)
    if intent is None:
        return _send(method, path, env, params, retries)
    fields = {k: params[k] for k in _AUDIT_KEYS if k in (params or {})}
    fields["intent"] = intent
    if ("uta" if path.startswith("/api/v3/") else "classic") not in acct.VERIFIED_MODES:
        # account_mode() refuses an unverified type too; this one reads the API off the
        # request itself and leaves the attempt in the audit
        guard.audit("order_denied_unverified", **fields)
        raise BitgetError(f"Bitget 下單程式還沒通過真帳驗證，{fields.get('symbol')} 的單沒有送出（{intent}）："
                          f"Bitget 目前不能自動或手動下單", code=UNVERIFIED)
    guard.check_restart_stop(intent, fields)
    guard.check_account_hold("bitget", intent, fields)
    if intent == "entry" and guard.entry_blocked():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for "
            f"{fields.get('symbol')} refused before reaching the exchange. "
            f"Closes and cancels still work. Only the user may clear the halt "
            f"(guard.clear_halt)."
        )
    if intent == "entry" and acct.switch_hold_left() > 0:
        guard.audit("order_denied_mode_switch", **fields)
        raise BitgetError(f"bitget: 帳戶類型剛切換，{fields.get('symbol')} 的開倉單先不送（等原本的部位"
                          f"讀回來、至少 {acct.SWITCH_HOLD_S} 秒）；平倉照常", code=acct.MODE_SWITCH)
    guard.audit("order_attempt", **fields)
    try:
        data = _send(method, path, env, params, retries)
    except Exception as e:
        guard.audit("order_error", error=str(e), **fields)
        raise
    oid = data.get("orderId") if isinstance(data, dict) else ""
    guard.audit("order_ok", order_id=str(oid or ""), **fields)
    return data


def _send(method, path, env, params=None, retries=3):
    method = method.upper()
    params = dict(params or {})
    last_err = None
    resynced = False
    for attempt in range(retries):
        if method == "GET":
            rp, payload = acct.request_path(path, params), ""
        else:
            rp, payload = path, json.dumps(params, separators=(",", ":"))
        h = acct.headers(env, method, rp, payload)
        try:
            r = requests.request(method, f"{acct.HOST}{rp}", headers=h, data=payload or None, timeout=15)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            # a POST whose reply died may have landed: never resend it — find it by
            # its clientOid (the reconciler re-reads positions next round if even
            # that cannot tell)
            if method == "POST":
                found = _lookup_cid(env, params) if path in (ORDER_PATH, V3_ORDER_PATH) else None
                if found:
                    return found
                raise
            last_err = e
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt)
            continue
        err = acct.error_of(env, r, path)
        if err is None:
            return r.json().get("data")
        if err.code == acct.UTA_MODE:
            # the account became a UTA under us: refused, so nothing landed — never re-sent
            # to v3 here; the next round places it under the new mode (after the hold)
            raise acct.switched(env, err) from err
        if err.code in acct.TIMESTAMP_CODES and not resynced and attempt < retries - 1:
            # refused at authentication — resending cannot double anything
            resynced = True
            acct.sync_time()
            last_err = err
            continue
        retryable = err.code == acct.RATE_LIMITED or (method == "GET" and r.status_code >= 500)
        if retryable and attempt < retries - 1:
            time.sleep(1 + attempt * 2)
            last_err = err
            continue
        if path in (ORDER_PATH, V3_ORDER_PATH) and (err.code in _UNCERTAIN or r.status_code >= 500):
            found = _lookup_cid(env, params)
            if found:
                return found
        raise err
    raise last_err


def _lookup_cid(env, params):
    """The order a clientOid already names ({'orderId', 'clientOid'}), or None."""
    cid, sym = (params or {}).get("clientOid"), (params or {}).get("symbol")
    if not cid or not sym:
        return None
    try:
        if "category" in (params or {}):
            row = _send("GET", V3_DETAIL_PATH, env, {"clientOid": cid}, retries=1)
        else:
            row = _send("GET", DETAIL_PATH, env, {"symbol": sym, "productType": PRODUCT, "clientOid": cid},
                        retries=1)
    except Exception:
        return None
    return {"orderId": row.get("orderId"), "clientOid": cid} if isinstance(row, dict) and row.get("orderId") else None


# ── contract rules ───────────────────────────────────────────────────────────

def _floor_str(value, step):
    """Floor to a whole number of `step` (the venue's own string), as a plain decimal."""
    s = Decimal(str(step))
    if s <= 0:
        return str(value)
    v = Decimal(str(value))
    return format(((v / s).to_integral_value(rounding=ROUND_DOWN) * s).quantize(s), "f")


def _tick(row):
    places = int(row.get("pricePlace") or 0)
    return format(Decimal(str(row.get("priceEndStep") or 1)).scaleb(-places), "f")


def get_contract_rules(env, symbol):
    """{'step','min_qty','min_notional','contract_value' (1: size is base),'tick',
    'equity' (isRwa: a stock perp, read by lib.venue_wiring.instrument_gate),'status'}.
    Public data only. A contract Bitget does not list, has delisted ('off') or closed to
    the API ('restrictedAPI') is refused with the symbol_unavailable token."""
    vsym = venue_symbol(symbol)
    hit = _rules_cache.get(vsym)
    if hit and time.time() - hit[0] < RULES_TTL_S:
        return hit[1]
    try:
        rows = acct.public("/api/v2/mix/market/contracts", {"productType": PRODUCT, "symbol": vsym}) or []
    except BitgetError as e:
        if e.code == UNKNOWN_SYMBOL:
            raise BitgetError(f"Bitget 沒有 {vsym} 這個 USDT 永續合約（{e}）",
                              code=e.code, kind=reject_token.SYMBOL_UNAVAILABLE) from e
        raise
    row = next((r for r in rows if r.get("symbol") == vsym), None)
    if row is None:
        raise BitgetError(f"Bitget 沒有 {vsym} 這個 USDT 永續合約",
                          kind=reject_token.SYMBOL_UNAVAILABLE)
    status = str(row.get("symbolStatus") or "")
    if status in ("off", "restrictedAPI"):
        why = "已下架" if status == "off" else "不開放 API 下單，只能在 Bitget App 手動交易"
        raise BitgetError(f"Bitget 的 {vsym} {why}（symbolStatus={status}）",
                          kind=reject_token.SYMBOL_UNAVAILABLE)
    rwa = row.get("isRwa")
    rules = {
        "step": str(row["sizeMultiplier"]),
        "min_qty": float(row["minTradeNum"]),
        "min_notional": float(row.get("minTradeUSDT") or 0),
        "contract_value": 1.0,
        "tick": _tick(row),
        "equity": None if rwa is None else rwa == "YES",
        "status": status,
    }
    _rules_cache[vsym] = (time.time(), rules)
    return rules


def format_qty(env, symbol, qty, price=None):
    """Floor a BASE qty to the step; '' when it is below the venue minimum.
    MIN-SIZE GATE ONLY — never feed the result back into place_market_order."""
    rules = get_contract_rules(env, symbol)
    floored = _floor_str(abs(float(qty)), rules["step"])
    if float(floored) < rules["min_qty"]:
        return ""
    if rules["min_notional"] and price and float(floored) * float(price) < rules["min_notional"]:
        return ""
    return floored


def format_price(env, symbol, price, buy=True):
    """Price string on the tick. Buys round down and sells up, so a passive price
    never rounds into the book."""
    tick = Decimal(get_contract_rules(env, symbol)["tick"])
    p = Decimal(str(price))
    out = (p / tick).to_integral_value(rounding=ROUND_DOWN if buy else ROUND_UP) * tick
    if out <= 0:
        raise ValueError(f"{symbol}: price {price} formats to {out}")
    return format(out.quantize(tick), "f")


def _trigger_price(env, symbol, price):
    tick = Decimal(get_contract_rules(env, symbol)["tick"])
    out = (Decimal(str(price)) / tick).to_integral_value(rounding=ROUND_HALF_UP) * tick
    if out <= 0:
        raise ValueError(f"{symbol}: trigger {price} formats to {out}")
    return format(out.quantize(tick), "f")


def session_open(env, symbol):
    """False while Bitget forbids opening the contract (symbolStatus limit_open,
    maintain, or not yet listed) or the account type has just switched
    (account_bitget.switch_hold_left) — lib.venue_wiring.paused_symbols holds
    entries; reduces still go out."""
    if acct.switch_hold_left() > 0:
        return False
    return get_contract_rules(env, symbol)["status"] == "normal"


# ── positions / modes ────────────────────────────────────────────────────────

_POS_MODES = {"one_way_mode": "oneway", "hedge_mode": "hedge"}


def _modes(env, vsym):
    """(api 'uta'|'classic', posMode 'oneway'|'hedge', marginMode 'crossed'|'isolated'|None)
    for one symbol, read fresh. UTA: hold mode from the account settings, margin mode from
    its symbolConfigList (None = the symbol has no entry; the order then names none)."""
    api = acct.account_mode(env)
    if api == "uta":
        st = acct.uta_settings(env)
        pos = _POS_MODES.get(str(st.get("holdMode") or ""))
        if pos is None:
            raise BitgetError(f"bitget settings: unreadable holdMode ({str(st)[:160]})")
        margin = None
        for c in st.get("symbolConfigList") or []:
            if isinstance(c, dict) and c.get("symbol") == vsym and c.get("category") in (None, CATEGORY):
                margin = str(c.get("marginMode") or "") or None
        if margin not in (None, "crossed", "isolated"):
            raise BitgetError(f"bitget {vsym}: unreadable margin mode {margin!r}")
        return api, pos, margin
    a = _request("GET", "/api/v2/mix/account/account", env,
                 {"symbol": vsym, "productType": PRODUCT, "marginCoin": MARGIN_COIN})
    pos = _POS_MODES.get(str((a or {}).get("posMode") or ""))
    margin = str((a or {}).get("marginMode") or "")
    if pos is None or margin not in ("crossed", "isolated"):
        raise BitgetError(f"bitget {vsym}: unreadable position / margin mode ({str(a)[:160]})")
    return api, pos, margin


def get_position_mode(env):
    """'oneway' | 'hedge' — account-wide on Bitget (read off any symbol)."""
    return _modes(env, "BTCUSDT")[1]


def _leg_available(env, vsym, direction):
    """Base qty of that leg not locked by pending close orders."""
    total = Decimal(0)
    for p in acct.leg_rows(env):
        if p["symbol"] == vsym and p["side"] == direction:
            total += abs(Decimal(str(p["available"])))
    return total


def get_mark_price(env, symbol):
    """Mark price off the public ticker (lastPr when there is none) — USD→qty
    conversion and execute._venue_min_slice_usd."""
    t = _ticker(venue_symbol(symbol))
    px = float(t.get("markPrice") or t.get("lastPr") or 0)
    if px <= 0:
        raise BitgetError(f"bitget {symbol}: ticker has no mark / last price")
    return px


def _ticker(vsym):
    rows = acct.public("/api/v2/mix/market/ticker", {"symbol": vsym, "productType": PRODUCT}) or []
    row = rows[0] if isinstance(rows, list) and rows else None
    if not isinstance(row, dict) or row.get("symbol") != vsym:
        raise BitgetError(f"bitget: no ticker for {vsym}", kind=reject_token.SYMBOL_UNAVAILABLE)
    return row


# ── orders ───────────────────────────────────────────────────────────────────

def _sides(direction, reduce_only, pos_mode, api="classic"):
    """Body fields that say the order's side — THE SIDE TABLE in the module docstring.
    Classic hedge: side = the leg, tradeSide open|close. UTA hedge: side = the order's
    direction, posSide = the leg. One-way (both): side = the order's direction,
    reduceOnly on a reduce (v2 YES, v3 yes)."""
    buys = (direction == "long") != bool(reduce_only)
    if pos_mode == "hedge":
        if api == "uta":
            out = {"side": "buy" if buys else "sell", "posSide": direction}
            if reduce_only and UTA_HEDGE_REDUCE_ONLY:
                out["reduceOnly"] = "yes"
            return out
        return {"side": "buy" if direction == "long" else "sell",
                "tradeSide": "close" if reduce_only else "open"}
    out = {"side": "buy" if buys else "sell"}
    if reduce_only:
        out["reduceOnly"] = "yes" if api == "uta" else "YES"
    return out


def _cid(client_order_id=None):
    if not client_order_id:
        return "rc" + time.strftime("%y%m%d%H%M%S", time.gmtime()) + f"{int(time.time() * 1e6) % 1000000:06d}"
    cid = str(client_order_id)
    if not _CID_RE.match(cid):
        raise ValueError(f"client_order_id {cid[:40]!r}: use 1-32 of [A-Za-z0-9_-]")
    return cid


def _fee_v3(o):
    total, seen = 0.0, False
    for d in o.get("feeDetail") or []:
        f = (d or {}).get("fee")
        if f not in (None, ""):
            total += abs(float(f))
            seen = True
    return total if seen else None


def _norm(o):
    """One order, either API → {'order_id','client_order_id','status' (open|filled|canceled),
    'raw_status','avg_price','executed_qty','orig_qty','commission','reduce_only','cancel_reason'}."""
    if not isinstance(o, dict) or ("state" not in o and "orderStatus" not in o):
        raise BitgetError(f"bitget: order reply has no state ({str(o)[:160]})")
    v3 = "orderStatus" in o
    raw = str(o.get("orderStatus") if v3 else o.get("state") or "").lower()
    executed = abs(float((o.get("cumExecQty") if v3 else o.get("baseVolume")) or 0))
    if raw in _FILLED:
        status = "filled"
    elif raw in _GONE:
        # a market order's unfilled rest is cancelled: terminal, maybe not empty
        status = "filled" if executed > 0 else "canceled"
    else:
        status = "open"
    avg = o.get("avgPrice") if v3 else o.get("priceAvg")
    if v3:
        fee = _fee_v3(o)
    else:
        fee = o.get("fee")
        fee = abs(float(fee)) if fee not in (None, "") else None
    side, pos = str(o.get("side") or "").lower(), str(o.get("posSide") or "").lower()
    reduce = (str(o.get("reduceOnly") or "").upper() == "YES"
              or str(o.get("tradeSide") or "").lower() == "close"
              or (v3 and ((pos == "long" and side == "sell") or (pos == "short" and side == "buy"))))
    return {
        "order_id": str(o.get("orderId") or ""),
        "client_order_id": o.get("clientOid") or "",
        "status": status,
        "raw_status": raw,
        "avg_price": float(avg) if avg not in (None, "") else 0.0,
        "executed_qty": executed,
        "orig_qty": abs(float((o.get("qty") if v3 else o.get("size")) or 0)),
        "commission": fee,
        "reduce_only": reduce,
        "cancel_reason": o.get("cancelReason") or "",
    }


def get_order(env, symbol, order_id=None, client_order_id=None):
    """One order, normalized: {'order_id','status' (open|filled|canceled),'avg_price',
    'executed_qty','orig_qty','commission'} — quantities in base units."""
    if not order_id and not client_order_id:
        raise ValueError("get_order needs order_id or client_order_id")
    ident = {"orderId": order_id} if order_id else {"clientOid": client_order_id}
    if acct.account_mode(env) == "uta":
        o = _request("GET", V3_DETAIL_PATH, env, ident)
        if not o:
            raise BitgetError(f"bitget: no order {ident}", code=ORDER_ABSENT)
        return _norm(o)
    return _norm(_request("GET", DETAIL_PATH, env,
                          {"symbol": venue_symbol(symbol), "productType": PRODUCT, **ident}))


def _confirm(env, symbol, order_id, cid, timeout=20):
    deadline = time.time() + timeout
    delay = 0.4
    o = None
    while time.time() < deadline:
        o = get_order(env, symbol, order_id=order_id, client_order_id=None if order_id else cid)
        if o["status"] != "open":
            return o
        time.sleep(delay)
        delay = min(delay * 1.6, 2.0)
    raise OrderNotConfirmed(
        f"bitget {symbol} order {order_id or cid} still {o and o['raw_status']} after {timeout}s "
        f"— re-query by clientOid, do NOT resubmit")


def _sized(env, symbol, vsym, direction, qty, reduce_only, rules):
    """Base qty on the step, a reduce capped at the leg's available size; None = skip."""
    step = rules["step"]
    sized = Decimal(_floor_str(abs(float(qty)), step))
    if reduce_only:
        sized = min(sized, Decimal(_floor_str(_leg_available(env, vsym, direction), step)))
        return sized if sized > 0 else None
    return sized if sized >= Decimal(str(rules["min_qty"])) else None


def _post_order(env, api, body):
    # literal paths: tests/check_restart_stop_order_gate.py reads every non-GET path's intent
    if api == "uta":
        return _request("POST", "/api/v3/trade/place-order", env, body)
    return _request("POST", "/api/v2/mix/order/place-order", env, body)


def _order_body(api, vsym, sized, order_type, cid, sides, margin, price=None, force=None):
    """The body of one order in the account's API (sent by _post_order)."""
    if api == "uta":
        body = {"category": CATEGORY, "symbol": vsym, "qty": format(sized, "f"), "orderType": order_type,
                "clientOid": cid, **sides}
        if margin:
            body["marginMode"] = margin
        if price is not None:
            body["price"] = price
            body["timeInForce"] = force
        return body
    body = {"symbol": vsym, "productType": PRODUCT, "marginMode": margin, "marginCoin": MARGIN_COIN,
            "size": format(sized, "f"), "orderType": order_type, "clientOid": cid, **sides}
    if price is not None:
        body["price"] = price
        body["force"] = force
    return body


def place_market_order(env, symbol, direction, qty, client_order_id=None, reduce_only=False):
    """Confirmed market order. qty is BASE units. direction is the position's
    ('long'|'short'); with reduce_only, the leg being closed — capped at what that
    leg holds. Below the venue minimum (or nothing to close) → False. Returns
    {'avg_price','executed_qty','commission','order_id'} as the venue reports."""
    guard.arm_restore(symbol, direction, qty, reduce_only)  # HALT's one netted-restore pass
    if direction not in ("long", "short"):
        raise ValueError(f"direction must be 'long' or 'short', got {direction!r}")
    vsym = venue_symbol(symbol)
    rules = get_contract_rules(env, symbol)
    sized = _sized(env, symbol, vsym, direction, qty, reduce_only, rules)
    if sized is None:
        return False
    if not reduce_only and rules["min_notional"] and \
            float(sized) * get_mark_price(env, symbol) < rules["min_notional"]:
        return False
    api, pos_mode, margin_mode = _modes(env, vsym)
    cid = _cid(client_order_id)
    body = _order_body(api, vsym, sized, "market", cid,
                             _sides(direction, reduce_only, pos_mode, api), margin_mode)
    try:
        placed = _post_order(env, api, body)
    except BitgetError as e:
        if e.code in BELOW_MIN:  # value under minTradeUSDT after the venue's own rounding
            return False
        raise
    oid = (placed or {}).get("orderId")
    o = _confirm(env, symbol, oid, cid)
    if o["status"] != "filled":
        raise BitgetError(f"bitget {vsym} market order {o['order_id'] or cid} ended {o['raw_status']} "
                          f"with nothing filled ({o['cancel_reason'] or 'no reason given'})")
    return {"avg_price": o["avg_price"], "executed_qty": o["executed_qty"],
            "commission": o["commission"], "order_id": o["order_id"]}


def close_position_partial(env, symbol, direction, qty, client_order_id=None):
    """Reduce the `direction` leg by a BASE qty. Under HALT only as the user's
    explicit close (lib.guard halt close pass)."""
    return place_market_order(env, symbol, direction, qty,
                              client_order_id=client_order_id, reduce_only=True)


def cancel_order(env, symbol, order_id=None, client_order_id=None):
    """Cancel one regular order. Bitget's cancel is acknowledged, not final, so an
    accepted cancel is 'cancel_accepted' (the caller confirms with get_order);
    an order that is gone or never existed is 'order_not_found', never an exception."""
    if not order_id and not client_order_id:
        raise ValueError("cancel_order needs order_id or client_order_id")
    if acct.account_mode(env) == "uta":
        return _cancel_v3(env, symbol, order_id, client_order_id)
    body = {"symbol": venue_symbol(symbol), "productType": PRODUCT, "marginCoin": MARGIN_COIN}
    if order_id:
        body["orderId"] = str(order_id)
    else:
        body["clientOid"] = client_order_id
    try:
        res = _request("POST", "/api/v2/mix/order/cancel-order", env, body)
    except BitgetError as e:
        if e.code in _CANCEL_GONE:
            return {"status": "order_not_found", "order_id": order_id}
        raise
    return {"status": "cancel_accepted", "order_id": str((res or {}).get("orderId") or order_id)}


def _cancel_v3(env, symbol, order_id, client_order_id):
    """UTA cancel: orderId | clientOid + category (no symbol on this endpoint). The v3 code
    for an order that is gone is not measured yet (R9U): a refused cancel is answered by
    reading the order — terminal or unknown to Bitget → order_not_found; still open → raise."""
    body = {"category": CATEGORY}
    body.update({"orderId": str(order_id)} if order_id else {"clientOid": client_order_id})
    try:
        res = _request("POST", "/api/v3/trade/cancel-order", env, body)
    except BitgetError as e:
        if e.code == acct.MODE_SWITCH:
            raise
        try:
            o = get_order(env, symbol, order_id=order_id, client_order_id=client_order_id)
        except BitgetError as e2:
            # only an explicit "no such order" is gone (cancelled API orders are kept only 2 h);
            # anything else — 5xx, 40010, clock, permission — is UNKNOWN and raises: a live
            # order read as gone is re-placed by the chase and fills twice
            if e2.code in _V3_ORDER_GONE:
                return {"status": "order_not_found", "order_id": order_id}
            raise e from e2
        if o["status"] != "open":
            return {"status": "order_not_found", "order_id": o["order_id"] or order_id}
        raise e
    return {"status": "cancel_accepted", "order_id": str((res or {}).get("orderId") or order_id)}


def cancel_all_orders(env, symbol):
    """Cancel every regular AND plan (TP/SL) order on the symbol, one by one —
    Bitget's own cancel-all-orders takes no symbol and would clear the whole
    account. close_symbol: only when the position is being closed too."""
    return {"orders": [cancel_order(env, symbol, order_id=o["order_id"])
                       for o in get_open_orders(env, symbol)],
            "algo_orders": cancel_protective_orders(env, symbol)}


# ── limit layer ──────────────────────────────────────────────────────────────

def get_bbo(env, symbol):
    """Top of the real book {'bid', 'ask'} off the ticker's bidPr / askPr — never mark or last."""
    t = _ticker(venue_symbol(symbol))
    bid, ask = float(t.get("bidPr") or 0), float(t.get("askPr") or 0)
    if bid <= 0 or ask <= 0:
        raise BitgetError(f"bitget {symbol}: ticker has no bid / ask ({str(t)[:120]})")
    return {"bid": bid, "ask": ask}


def place_limit_order(env, symbol, direction, qty, price, client_order_id=None,
                      reduce_only=False, time_in_force="GTC", post_only=False):
    """Limit order, UNCONFIRMED (it may rest): {'order_id','client_order_id','status'}.
    qty is BASE units; direction is the position's, with reduce_only the leg being
    closed (capped at what it holds). post_only → force post_only; one Bitget
    cancelled instead of resting (it would have crossed) returns
    {'status': 'post_only_rejected'}. Below the venue minimum → False."""
    if direction not in ("long", "short"):
        raise ValueError(f"direction must be 'long' or 'short', got {direction!r}")
    vsym = venue_symbol(symbol)
    rules = get_contract_rules(env, symbol)
    sized = _sized(env, symbol, vsym, direction, qty, reduce_only, rules)
    if sized is None:
        return False
    if not reduce_only and rules["min_notional"] and float(sized) * float(price) < rules["min_notional"]:
        return False
    api, pos_mode, margin_mode = _modes(env, vsym)
    buy = (direction == "long") != bool(reduce_only)
    cid = _cid(client_order_id)
    body = _order_body(api, vsym, sized, "limit", cid, _sides(direction, reduce_only, pos_mode, api),
                             margin_mode, price=format_price(env, symbol, price, buy=buy),
                             force="post_only" if post_only else str(time_in_force).lower())
    try:
        placed = _post_order(env, api, body)
    except BitgetError as e:
        if e.code in BELOW_MIN:
            return False
        raise
    oid = (placed or {}).get("orderId")
    if post_only:
        o = get_order(env, symbol, order_id=oid, client_order_id=None if oid else cid)
        oid = o["order_id"] or oid
        if o["status"] == "canceled":
            return {"status": "post_only_rejected", "order_id": oid}
    if not oid:
        oid = get_order(env, symbol, client_order_id=cid)["order_id"]
    return {"order_id": str(oid), "client_order_id": cid, "status": "open"}


def get_open_orders(env, symbol=None):
    """Open regular orders (orphan sweep, close_symbol). TP/SL orders are a separate
    list on this venue — see get_open_algo_orders."""
    if acct.account_mode(env) == "uta":
        q = {"category": CATEGORY, "limit": 100}
        if symbol:
            q["symbol"] = venue_symbol(symbol)
        rows = (_request("GET", "/api/v3/trade/unfilled-orders", env, q) or {}).get("list") or []
    else:
        q = {"productType": PRODUCT, "limit": 100}
        if symbol:
            q["symbol"] = venue_symbol(symbol)
        rows = (_request("GET", "/api/v2/mix/order/orders-pending", env, q) or {}).get("entrustedList") or []
    out = []
    for o in rows:
        n = _norm({"state": "live", **o})
        out.append({
            "order_id": n["order_id"],
            "client_order_id": n["client_order_id"],
            "symbol": canonical_symbol(o.get("symbol")),
            "side": o.get("side"),
            "trade_side": o.get("tradeSide"),
            "pos_side": o.get("posSide"),
            "type": o.get("orderType"),
            "qty": n["orig_qty"],
            "price": float(o.get("price") or 0),
            "reduce_only": n["reduce_only"],
        })
    return out


# ── protective orders (position TP/SL) ───────────────────────────────────────

_PLAN_TYPES = (("sl", "pos_loss"), ("tp", "pos_profit"))


def _protective_body(api, pos_mode, vsym, direction, kind, plan, trigger, margin=None):
    """The body of one SL or TP on the `direction` leg. Classic: position TP/SL,
    holdSide = the leg (hedge) or the position's buy/sell (one-way). UTA: a `tpsl`
    strategy order in `full` mode (the whole leg), side = the CLOSING direction +
    posSide = the leg in both position modes (as ccxt sends it; T8U / T12U measure
    one-way), one order per kind."""
    if api == "uta":
        k = "sl" if kind == "sl" else "tp"
        body = {
            "category": CATEGORY, "symbol": vsym, "type": "tpsl", "tpslMode": "full",
            "side": "sell" if direction == "long" else "buy", "posSide": direction,
            ("stopLoss" if k == "sl" else "takeProfit"): trigger,
            f"{k}TriggerBy": "mark", f"{k}OrderType": "market", "clientOid": _cid()}
        if margin:
            body["marginMode"] = margin  # UTA error 31008: an isolated leg is not found without it
        return body
    hold = direction if pos_mode == "hedge" else ("buy" if direction == "long" else "sell")
    return {"marginCoin": MARGIN_COIN, "productType": PRODUCT, "symbol": vsym,
                       "planType": plan, "triggerPrice": trigger, "triggerType": "mark_price",
                       "holdSide": hold, "clientOid": _cid()}


def place_protective_orders(env, symbol, direction, sl_price=None, tp_price=None,
                            verify=True, _after_entry=False):
    """Stop-loss / take-profit on an EXISTING position: Bitget's position TP/SL
    (pos_loss / pos_profit — the whole leg, market execution, mark-price trigger).
    Verified in the open plan list; raises ProtectionFailed otherwise. Returns
    {'sl'|'tp': {'algoId', 'raw'}}; cancel with cancel_algo_order /
    cancel_protective_orders."""
    if sl_price is None and tp_price is None:
        raise ValueError("place_protective_orders needs sl_price and/or tp_price")
    vsym = venue_symbol(symbol)
    placed = {}
    try:
        api, pos_mode, margin_mode = _modes(env, vsym)
        for kind, plan in _PLAN_TYPES:
            trigger = sl_price if kind == "sl" else tp_price
            if trigger is None:
                continue
            body = _protective_body(api, pos_mode, vsym, direction, kind, plan,
                                    _trigger_price(env, symbol, trigger), margin_mode)
            if api == "uta":
                o = _request("POST", "/api/v3/trade/place-strategy-order", env, body)
            else:
                o = _request("POST", "/api/v2/mix/order/place-tpsl-order", env, body)
            if not (o or {}).get("orderId"):
                raise BitgetError(f"bitget {vsym}: {kind} reply has no orderId ({str(o)[:160]})")
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
                                   f"but NOT in the open plan list — position may be naked")
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


def get_open_algo_orders(env, symbol=None):
    """Open TP/SL orders, this lib's and any the user placed. Classic: plan orders of
    planType profit_loss; UTA: `tpsl` strategy orders in status pending (the list takes
    no symbol — filtered here). stop_order_type is pos_loss / pos_profit in both."""
    vsym = venue_symbol(symbol) if symbol else None
    if acct.account_mode(env) == "uta":
        data = _request("GET", "/api/v3/trade/unfilled-strategy-orders", env,
                        {"category": CATEGORY, "type": "tpsl"})
        rows = (data.get("list") if isinstance(data, dict) else data) or []
        out = []
        for o in rows:
            if vsym and o.get("symbol") != vsym:
                continue
            if str(o.get("status") or "pending").lower() not in ("pending", "submitting"):
                continue
            sl = o.get("stopLoss") not in (None, "")
            out.append({
                "order_id": str(o.get("orderId") or ""),
                "client_order_id": str(o.get("clientOid") or ""),
                "symbol": canonical_symbol(o.get("symbol")),
                "side": o.get("side"),
                "pos_side": o.get("posSide"),
                "stop_order_type": "pos_loss" if sl else "pos_profit",
                "trigger_price": float((o.get("stopLoss") if sl else o.get("takeProfit")) or 0),
            })
        return out
    q = {"productType": PRODUCT, "planType": "profit_loss"}
    if vsym:
        q["symbol"] = vsym
    rows = (_request("GET", "/api/v2/mix/order/orders-plan-pending", env, q) or {}).get("entrustedList") or []
    return [{
        "order_id": str(o.get("orderId") or ""),
        "client_order_id": str(o.get("clientOid") or ""),
        "symbol": canonical_symbol(o.get("symbol")),
        "side": o.get("side"),
        "pos_side": o.get("posSide"),
        "stop_order_type": o.get("planType"),
        "trigger_price": float(o.get("triggerPrice") or 0),
    } for o in rows]


def cancel_algo_order(env, symbol, order_id, plan_type=None):
    """Cancel one TP/SL order. 'canceled' when Bitget lists it as cancelled (UTA: the
    order is no longer pending), 'order_not_found' when it is gone; any other failure
    raises."""
    if acct.account_mode(env) == "uta":
        return _cancel_strategy_v3(env, symbol, order_id)
    body = {"orderIdList": [{"orderId": str(order_id)}], "symbol": venue_symbol(symbol),
            "productType": PRODUCT, "marginCoin": MARGIN_COIN}
    if plan_type:
        body["planType"] = plan_type
    try:
        res = _request("POST", "/api/v2/mix/order/cancel-plan-order", env, body) or {}
    except BitgetError as e:
        if e.code in _PLAN_GONE:
            return {"status": "order_not_found", "order_id": str(order_id)}
        raise
    if any(str(x.get("orderId")) == str(order_id) for x in res.get("successList") or []):
        return {"status": "canceled", "order_id": str(order_id)}
    if not res.get("successList") and not res.get("failureList"):
        # measured on a classic key (R9, 2026-10-22): an id Bitget does not know answers both
        # lists empty, no code — gone only if the open plan list agrees
        if all(o["order_id"] != str(order_id) for o in get_open_algo_orders(env, symbol)):
            return {"status": "order_not_found", "order_id": str(order_id)}
    fail = next((x for x in res.get("failureList") or [] if str(x.get("orderId")) == str(order_id)), {})
    if str(fail.get("errorCode")) in _PLAN_GONE:
        return {"status": "order_not_found", "order_id": str(order_id)}
    raise BitgetError(f"bitget {symbol}: plan order {order_id} not cancelled ({str(res)[:200]})",
                      code=fail.get("errorCode"))


def _cancel_strategy_v3(env, symbol, order_id):
    """UTA: cancel-strategy-order answers data null; whether it worked is read back off
    the pending list (the v3 "gone" code is not measured yet — R9U)."""
    try:
        _request("POST", "/api/v3/trade/cancel-strategy-order", env, {"orderId": str(order_id)})
        err = None
    except BitgetError as e:
        if e.code == acct.MODE_SWITCH:
            raise
        err = e
    still = any(o["order_id"] == str(order_id) for o in get_open_algo_orders(env, symbol))
    if not still:
        return {"status": "canceled" if err is None else "order_not_found", "order_id": str(order_id)}
    raise BitgetError(f"bitget {symbol}: TP/SL order {order_id} still pending after cancel"
                      + (f" ({err})" if err else ""), code=getattr(err, "code", None))


def cancel_protective_orders(env, symbol):
    """Cancel every TP/SL plan order on the symbol. Returns the cancel results."""
    return [cancel_algo_order(env, symbol, o["order_id"], o["stop_order_type"])
            for o in get_open_algo_orders(env, symbol)]


def _symbol_held(env, vsym):
    return sum(p["total"] for p in acct.leg_rows(env) if p["symbol"] == vsym)


def _report_stops_failure(sym, err):
    msg = (f"{sym} 已沒有部位，但 Bitget 上它的止損／止盈單撤不掉，請到 Bitget App 手動撤掉，"
           f"否則之後再開倉時可能被它平掉（bitget: {err}）")
    logging.error(msg)
    try:
        guard.audit("stops_cancel_failed", symbol=sym, error=str(err)[:200])
    except Exception:
        pass
    try:
        from lib import portfolio
        fresh = portfolio._order_error_fresh(sym, msg, "protective")
        portfolio._record_order_error(sym, "bitget", msg, repeat=not fresh)
        if fresh:
            from lib import notify
            notify.send_text(f"⚠️ {msg}")
    except Exception as e:
        logging.error(f"bitget {sym}: stop-cancel failure could not be reported ({e})")


def sweep_orphan_stops(env, positions=None):
    """Every reconcile round (lib.venue_wiring.auto_get_positions): cancel the TP/SL
    plan orders of a symbol that holds nothing — whether Bitget drops a position's
    TP/SL with the position is a live-verify item (T10); this makes the answer not
    matter. Per symbol, not per leg: a hedge account holding the other leg keeps
    them. Each candidate is re-read twice before anything is cancelled. Never
    raises. Returns the symbols swept."""
    try:
        stops = get_open_algo_orders(env)
    except Exception as e:
        logging.warning(f"bitget: open plan list unreadable, orphan sweep skipped ({e})")
        return []
    held = {p.get("symbol") for p in positions or [] if float(p.get("size") or 0) > 0}
    swept = []
    for sym in sorted({x["symbol"] for x in stops} - held):
        try:
            vsym = venue_symbol(sym)
            if _symbol_held(env, vsym) > 0 or _symbol_held(env, vsym) > 0:
                continue
            res = [cancel_algo_order(env, sym, x["order_id"], x["stop_order_type"])
                   for x in stops if x["symbol"] == sym]
            guard.audit("stops_cancelled_on_flat", symbol=vsym, results=res)
            swept.append(sym)
        except Exception as e:
            _report_stops_failure(sym, e)
    return swept
