"""
StockCoin account library — USDT-perpetual (FUTURES) account equity and positions.

Discovered by filename (lib.account_stockcoin.get_equity / get_positions).
Credentials: STOCKCOIN_API_KEY / STOCKCOIN_SECRET_KEY in .env. The key must be
a FUTURES-type key (account_type 3); any other type answers -1005.

Read replies measured on a live key (tests/live_stockcoin_verify.py R1–R10, T8,
T11 — equity with 100 contracts open and unrealized PnL moving).

Measured: a wrong key answers -1002, a wrong secret -1022 (reads and order
placement) — both CREDENTIAL below.

Wallet model: a FUTURES key sees the futures account ONLY. Deposits land in the
main account and must be moved to futures in the StockCoin app first. No get_flows,
no get_holdings, no withdraw_enabled, on purpose: measured on a live key, /account
answers -1005 and every flow / transfer / deposit / withdrawal / sub-account read
the engine (BHEX) used to have — balance_flow, depositOrders, withdrawalOrders,
transfer history, futures income — answers -1008 Not Found. A deposit or
withdrawal therefore shows up as an equity jump the platform marks as a fund
movement (資金異動), never as profit or loss; the user turns withdrawal off on the
key themselves.

Sizes: positions come back in CONTRACTS; size here is base units (contracts ×
MULTIPLIERS below — the order lib imports the same table, so a read and an
order can never disagree on units).
"""

import hashlib
import hmac
import math
import time
from decimal import Decimal
from urllib.parse import urlencode

import requests

try:
    from lib import venue_errors
except ImportError:  # a file-by-file update that skipped lib/venue_errors.py must not break reads
    venue_errors = None

LIVE_HOST = "https://api.stockcoin.ai"
PREFIX = "/openapi/v1"
_time_offset = {"ms": 0}


def _tag(exc, code=None, http_status=None):
    return venue_errors.tag(exc, code, http_status) if venue_errors else exc


def _creds(env):
    api_key = env.get("STOCKCOIN_API_KEY")
    secret = env.get("STOCKCOIN_SECRET_KEY")
    if not api_key or not secret:
        raise ValueError("STOCKCOIN_API_KEY / STOCKCOIN_SECRET_KEY missing from .env")
    return api_key, secret


def _sync_time():
    try:
        t0 = time.time()
        r = requests.get(f"{LIVE_HOST}{PREFIX}/time", timeout=5)
        t1 = time.time()
        _time_offset["ms"] = int(r.json()["serverTime"]) - int((t0 + t1) / 2 * 1000)
    except Exception:
        pass


def _get(env, path, params=None, _resynced=False):
    """Signed GET. Errors arrive as HTTP 400 + {"code": <negative>} — read the
    body before the status, or a rejected key reads as a bare 400."""
    api_key, secret = _creds(env)
    q = {**(params or {}), "timestamp": int(time.time() * 1000) + _time_offset["ms"]}
    qs = urlencode(sorted((k, str(v)) for k, v in q.items()))
    sig = hmac.new(secret.encode(), qs.encode(), hashlib.sha256).hexdigest()
    r = requests.get(f"{LIVE_HOST}{PREFIX}{path}?{qs}&signature={sig}",
                     headers={"X-BH-APIKEY": api_key}, timeout=10)
    try:
        body = r.json()
    except ValueError:
        r.raise_for_status()
        raise _tag(Exception(f"stockcoin {path}: non-JSON reply"), http_status=r.status_code)
    code = body.get("code") if isinstance(body, dict) else None
    failed = r.status_code >= 400 or (code is not None and str(code).lstrip("-").isdigit()
                                      and int(code) < 0)
    if not failed:
        return body
    if str(code) == "-1021" and not _resynced:
        _sync_time()
        return _get(env, path, params, _resynced=True)
    msg = str(body.get("msg") or "") if isinstance(body, dict) else ""
    if api_key in msg:
        msg = msg.replace(api_key, "***")
    if str(code) == "-1005":
        msg += " (the key is not a FUTURES-type key — recreate it as a contract key and rebind)"
    raise _tag(Exception(f"stockcoin {path} code={code}: {msg}"),
               code=None if code is None else str(code), http_status=r.status_code)


# Base units per contract — THE table: lib/order_stockcoin sizes orders off
# it too. No endpoint publishes it (brokerInfo is closed); public 24h turnover
# reads 0.0001 for every listed symbol. Per-symbol rows win over the default;
# fill them from the contractMultiplier live order replies carry.
DEFAULT_MULTIPLIER = "0.0001"
MULTIPLIERS = {}


def multiplier(vsym):
    return Decimal(MULTIPLIERS.get(vsym, DEFAULT_MULTIPLIER))


def _canonical(vsym):
    return str(vsym or "").upper().replace("-PERP-", "").replace("-", "")


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _opt(v, positive=False):
    """A display-only detail as float or None (never 0 for unknown); never raises."""
    f = _num(v)
    if f is None or (positive and f <= 0):
        return None
    return f


def _position_rows(env):
    rows = _get(env, "/futures/positions")
    if not isinstance(rows, list):
        raise Exception(f"stockcoin /futures/positions: expected a list, got {str(rows)[:120]}")
    return rows


def get_positions(env: dict) -> list:
    """Open positions, one row per leg (hedge mode: a symbol can hold a LONG
    and a SHORT row at once — lib.venue_wiring nets them). mark_price is the
    row's lastPrice: the venue publishes no mark price."""
    out = []
    for p in _position_rows(env):
        contracts = abs(Decimal(str(p.get("position") or 0)))
        if contracts == 0:
            continue
        vsym = p.get("symbol") or ""
        side = str(p.get("side") or "").upper()
        if side not in ("LONG", "SHORT"):
            raise Exception(f"stockcoin position {vsym}: unknown side {side!r}")
        mark = _num(p.get("lastPrice")) or 0.0
        # a non-zero position we cannot value must raise, never be skipped:
        # a dropped row reads as flat and the reconciler re-buys on top of it
        if mark <= 0:
            raise Exception(f"stockcoin position {vsym}: no lastPrice on a non-zero position")
        out.append({
            "symbol": _canonical(vsym),
            "side": "long" if side == "LONG" else "short",
            "size": float(contracts * multiplier(vsym)),
            "mark_price": mark,
            "entry_price": _opt(p.get("avgPrice"), positive=True),
            "unrealized_pnl": _opt(p.get("unrealizedPnL")),
            "margin": _opt(p.get("margin"), positive=True),
            "leverage": _opt(p.get("leverage"), positive=True),
        })
    return out


def get_equity(env: dict) -> dict:
    """Equity = the USDT row's `total` + `totalUnRealizedPnl` (cross + isolated).
    The reply is a list of per-token rows; a futures account holding nothing
    answers [] — that is equity 0, not an error.
    Measured with a position open (T11): `total` is the wallet balance and stays
    put while the price moves; `futureAssetTotal` = total + totalUnRealizedPnl
    (49.99626933 + (-0.0004) = 49.99586933), so this counts uPnL exactly once."""
    bal = _get(env, "/futures/balance")
    if not isinstance(bal, list):
        raise Exception(f"stockcoin /futures/balance: expected a list, got {str(bal)[:120]}")
    row = next((r for r in bal if isinstance(r, dict) and r.get("tokenId") == "USDT"), None)
    if row is None:
        equity = 0.0
    else:
        total = _num(row.get("total"))
        if total is None:
            raise Exception(f"stockcoin /futures/balance: USDT row has no total ({str(row)[:160]})")
        equity = total + (_num(row.get("totalUnRealizedPnl")) or 0.0)
    return {
        "equity": equity,
        "currency": "USDT",
        "accounts": {"futures": round(equity, 8)},
    }


def get_account_id(env: dict) -> str:
    """The venue account id, read off the latest order (no account endpoint
    exists for a FUTURES key; positions.accountId is market-maker only).
    Raises before the first order — lib.portfolio.book_account_check treats
    that as 'unreadable', which only holds a book that already has rows."""
    rows = _get(env, "/futures/orders/history", {"limit": 1})
    acct = rows[0].get("accountId") if isinstance(rows, list) and rows else None
    if not acct:
        raise Exception("stockcoin: no order history yet — account id unreadable")
    return str(acct)


# Venue doc §6.1. Every key rejection is HTTP 400 with one of these codes, so
# venue_errors' 401 fallback never fires here.
_TRANSIENT = {"-1001", "-1003", "-1006", "-1007"}
_CREDENTIAL = {"-1002", "-1005", "-1022"}
_UNKNOWN = {"-1021", "-1000"}


def classify(exc) -> str:
    """lib.venue_errors TRANSIENT / CREDENTIAL / UNKNOWN for a failed read
    (this lib's errors and lib/order_stockcoin.StockcoinError)."""
    if venue_errors is None:
        return None
    return venue_errors.classify(exc, getattr(exc, "code", None), None,
                                 _TRANSIENT, _CREDENTIAL, _UNKNOWN)
