"""
OKX account library — swap (perpetual futures) equity & positions.

Discovered by filename (lib.account_okx.get_equity / get_positions).
Credentials: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE in .env.

OKX is unified-account: the trading account (spot + derivatives) is the
equity base; the separate funding wallet appears in the 'accounts' breakdown.
"""

import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import requests

try:
    from lib import venue_errors
except ImportError:  # a file-by-file update that skipped lib/venue_errors.py must not break reads
    venue_errors = None


def _tag(exc, code=None, http_status=None):
    return venue_errors.tag(exc, code, http_status) if venue_errors else exc


BASE_URL = "https://www.okx.com"

# acctLv "1" (Spot mode) cannot hold perpetual swaps: every swap order is refused
# with 51010. The message is what the user sees; the token is what the desktop and
# web match on. Same pair in lib/order_okx.py (files update one at a time).
ACCOUNT_MODE_TOKEN = "okx_account_mode"
ACCOUNT_MODE_MSG = "OKX 帳戶模式不支援合約：到 OKX 設定 → 帳戶模式，改成合約模式或跨幣種保證金"


class AccountModeError(Exception):
    """The OKX account is in a mode that cannot trade perpetual swaps."""


_time_offset = {"ms": 0}  # OKX's clock − ours — same scheme as lib/order_okx.py


def _sync_time(env):
    """After a 50102 ("Timestamp request expired": OKX accepts ±30 s): offset
    against OKX's own clock (/api/v5/public/time), best-effort — see lib/order_okx._sync_time."""
    headers = {"User-Agent": "Mozilla/5.0"}
    if str(env.get("OKX_DEMO", os.environ.get("OKX_DEMO", ""))).lower() == "true":
        headers["x-simulated-trading"] = "1"
    try:
        t0 = time.time()
        r = requests.get(f"{BASE_URL}/api/v5/public/time", headers=headers, timeout=5)
        t1 = time.time()
        server_ms = int(r.json()["data"][0]["ts"])
        _time_offset["ms"] = server_ms - int((t0 + t1) / 2 * 1000)
    except Exception:
        pass


def _timestamp():
    """ISO 8601 ms UTC: 2024-01-01T00:00:00.000Z"""
    now = datetime.now(timezone.utc) + timedelta(milliseconds=_time_offset["ms"])
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _sign(secret, ts, method, path, body=""):
    prehash = ts + method.upper() + path + body
    return base64.b64encode(
        hmac.new(secret.encode(), prehash.encode(), hashlib.sha256).digest()
    ).decode()


def _request(env, method, path, body=None, timeout=10, _resynced=False):
    api_key = env.get("OKX_API_KEY")
    secret = env.get("OKX_SECRET_KEY")
    passphrase = env.get("OKX_PASSPHRASE")
    if not api_key or not secret or not passphrase:
        raise ValueError("OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE missing from .env")

    ts = _timestamp()
    body_str = ""
    if body is not None:
        body_str = body if isinstance(body, str) else json.dumps(body)

    sig = _sign(secret, ts, method, path, body_str)

    headers = {
        "OK-ACCESS-KEY": api_key,
        "OK-ACCESS-SIGN": sig,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "User-Agent": "Mozilla/5.0",
    }
    # OKX demo trading (paired with demo-mode keys) — same flag as order_okx.py
    if str(env.get("OKX_DEMO", os.environ.get("OKX_DEMO", ""))).lower() == "true":
        headers["x-simulated-trading"] = "1"

    if method == "POST":
        headers["Content-Type"] = "application/json"
        r = requests.post(f"{BASE_URL}{path}", data=body_str, headers=headers, timeout=timeout)
    else:
        r = requests.get(f"{BASE_URL}{path}", headers=headers, timeout=timeout)

    try:
        data = r.json()
    except ValueError as e:
        raise _tag(e, http_status=r.status_code)
    code = data.get("code", "")
    if code != "0":
        msg = data.get("msg", "")
        if str(code) == "50102" and not _resynced:  # timestamp expired: resync, retry once
            _sync_time(env)
            return _request(env, method, path, body, timeout, _resynced=True)
        if str(code) == "51010":  # "Request unsupported under current account mode"
            raise _tag(AccountModeError(f"{ACCOUNT_MODE_MSG} [{ACCOUNT_MODE_TOKEN}] "
                                        f"(OKX {code}: {msg} | {method} {path})"),
                       code=code, http_status=r.status_code)
        raise _tag(Exception(f"OKX error {code}: {msg} | {method} {path}"),
                               code=code, http_status=r.status_code)
    return data.get("data", [])


def check_account_mode(env: dict) -> str:
    """acctLv of the account ('2' futures, '3' multi-currency, '4' portfolio
    margin). Raises AccountModeError on '1' (Spot mode): the bind and every
    account read then say what to change before the first order is refused."""
    rows = _request(env, "GET", "/api/v5/account/config")
    lv = str((rows[0] if rows else {}).get("acctLv") or "")
    if lv == "1":
        raise _tag(AccountModeError(f"{ACCOUNT_MODE_MSG} [{ACCOUNT_MODE_TOKEN}] (acctLv=1)"),
                   code=ACCOUNT_MODE_TOKEN)
    return lv


def get_equity(env: dict) -> dict:
    """Trading-account equity plus per-wallet breakdown.

    Returns {'equity': float, 'currency': str, 'accounts': {name: float}}.
    OKX is a unified-account venue: /api/v5/account/balance is the TRADING
    account (spot and derivatives share it; `totalEq` is USD-denominated),
    and /api/v5/asset/balances is the separate FUNDING wallet (USDT summed
    here). `equity` = the trading account — the wallet orders draw on.

    Raises AccountModeError on an account in Spot mode (check_account_mode) —
    this is the read the bind, the desktop gate and the cloud retest go through.
    """
    check_account_mode(env)
    rows = _request(env, "GET", "/api/v5/account/balance")
    trading = 0.0
    for acct in rows:
        trading += float(acct.get("totalEq", 0) or 0)

    accounts = {"trading": trading}
    # Best-effort: the funding breakdown failing must not take equity down.
    try:
        fund_rows = _request(env, "GET", "/api/v5/asset/balances")
        accounts["funding"] = sum(
            float(r.get("bal", 0) or 0) for r in fund_rows if r.get("ccy") == "USDT"
        )
    except Exception:
        pass

    # totalEq is USD-denominated (not USDT) — near-parity but label honestly
    return {"equity": trading, "currency": "USD", "accounts": accounts}


def get_holdings(env: dict) -> list:
    """Coin holdings — DISPLAY ONLY, never fed to the reconciler.

    OKX is unified-account: spot coins live inside the TRADING account
    (/api/v5/account/balance data[0].details[], per-asset `eq` with `eqUsd`
    already USD-valued — the same response get_equity reads); the separate
    FUNDING wallet (/api/v5/asset/balances) is valued via ONE bulk spot
    tickers call (per-asset lookups on a dusty wallet can eat the reader's
    60s alarm — audit M4). Returns [{'asset', 'amount', 'usdt_value',
    'wallet'}, ...] sorted by value desc; wallet ∈ {'trading','funding'}.
    Dust under 0.1 USD dropped — abs(), negative rows (borrow / multi-asset
    margin) are information, not noise. Unpriceable rows kept with
    usdt_value=None. Fail-loud per section: account_reader is the single
    best-effort layer, a partial list reads as "money vanished"."""
    out = []
    for acct in _request(env, "GET", "/api/v5/account/balance"):
        for d in acct.get("details", []):
            amt = float(d.get("eq", 0) or 0)
            if amt == 0:
                continue
            usd = d.get("eqUsd")
            out.append({"asset": d.get("ccy"), "amount": amt,
                        "usdt_value": round(float(usd), 2) if usd else None,
                        "wallet": "trading"})
    fund_rows = []
    for r in _request(env, "GET", "/api/v5/asset/balances"):
        amt = float(r.get("bal", 0) or 0)
        if amt == 0:
            continue
        row = {"asset": r.get("ccy"), "amount": amt, "usdt_value": None,
               "wallet": "funding"}
        fund_rows.append(row)
        out.append(row)
    if fund_rows:
        last = {}
        try:  # valuation only — a tickers hiccup degrades to usdt_value=None
            last = {r.get("instId"): float(r.get("last") or 0)
                    for r in _request(env, "GET", "/api/v5/market/tickers?instType=SPOT")}
        except Exception:
            pass
        for h in fund_rows:
            if h["asset"] == "USDT":
                h["usdt_value"] = round(h["amount"], 2)
            else:
                px = last.get(f"{h['asset']}-USDT")
                h["usdt_value"] = round(h["amount"] * px, 2) if px else None
    out = [h for h in out if h["usdt_value"] is None or abs(h["usdt_value"]) >= 0.1]
    out.sort(key=lambda h: -(h["usdt_value"] or 0))
    return out


def _flow_rows(env, path, id_key, since_ms):
    """All completed on-chain rows of an asset-history endpoint since since_ms.

    Server-side filters: type=4 (on-chain only — 3 would be internal transfer,
    both endpoints document the same request param) and state=2 (deposit
    successful / withdrawal success). Cursor pagination: `before` pins the
    lower ts bound (records NEWER than it — ccxt's executed reading; the doc
    example's from/to comment has them backwards), `after` walks older pages.
    Pages are 100 rows max; `after` is set to oldest_ts+1 so equal-ts rows on
    a page boundary are re-fetched instead of dropped, deduped via id."""
    seen, rows, after = set(), [], None
    for _ in range(60):
        params = {"type": "4", "state": "2",
                  "before": str(max(since_ms - 1, 0)), "limit": "100"}
        if after is not None:
            params["after"] = str(after)
        page = _request(env, "GET", f"{path}?{urlencode(params)}") or []
        new = 0
        for r in page:
            rid = r.get(id_key) or ""
            if rid in seen:
                continue
            seen.add(rid)
            new += 1
            rows.append(r)
        if len(page) < 100:
            return rows
        if new == 0:
            raise Exception(f"OKX flows: pagination stuck | {path}")
        after = min(int(r.get("ts") or 0) for r in page) + 1
    raise Exception(f"OKX flows: >6k records, pagination did not finish | {path}")


def get_flows(env: dict, since: int) -> list:
    """External (on-chain) deposit/withdraw records since `since` (epoch secs).

    Returns [{'ts', 'direction' ('in'/'out'), 'currency', 'amount', 'txid'}, ...]
    ascending by ts; amounts always positive. COMPLETED records only (state=2
    on both endpoints). Internal transfers (user-to-user / sub-account, dest=3)
    are excluded server-side via type=4 — only real external flows count for
    netting equity-snapshot PnL. No documented query-window cap on these
    endpoints; pagination is cursor-based (see _flow_rows). `txid` is the chain
    tx hash, falling back to OKX's depId/wdId. Withdrawal `amount` excludes the
    withdrawal fee (fee/feeCcy are separate fields), so fee-sized residue lands
    in PnL as a cost.
    """
    since_ms = int(since) * 1000
    flows = []
    for path, id_key, direction in (
            ("/api/v5/asset/deposit-history", "depId", "in"),
            ("/api/v5/asset/withdrawal-history", "wdId", "out")):
        for r in _flow_rows(env, path, id_key, since_ms):
            ts = int(r.get("ts") or 0)
            amt = float(r.get("amt") or 0)
            if ts < since_ms or amt <= 0:
                continue
            flows.append({
                "ts": ts // 1000,
                "direction": direction,
                "currency": r.get("ccy") or "",
                "amount": amt,
                "txid": r.get("txId") or str(r.get(id_key) or ""),
            })
    flows.sort(key=lambda f: f["ts"])
    return flows


_ctval_cache = {}  # instId -> float ctVal (per-process)


def _ct_val(env, inst_id):
    """ctVal (base units per contract) from the public instruments endpoint,
    cached. None on any failure — callers fall back to notional/markPx."""
    if inst_id not in _ctval_cache:
        try:
            rows = _request(env, "GET",
                            f"/api/v5/public/instruments?instType=SWAP&instId={inst_id}")
            _ctval_cache[inst_id] = float(rows[0]["ctVal"]) if rows else None
        except Exception:
            return None
    return _ctval_cache[inst_id]


def get_positions(env: dict) -> list:
    """Open swap positions.

    Returns [{'symbol': str, 'side': str, 'size': float, 'mark_price': float}, ...]
    Returns [] if flat.

    'size' is base-currency units, ctVal-exact (pos × ctVal via the public
    instruments lookup; notionalUsd / markPx only as fallback — see the inline
    comment), so the reconciler's `size * mark_price = USDT` formula works
    regardless of the instrument's ctVal. Symbols are CANONICAL (dashless
    uppercase, 'BTCUSDT') — the reconciler contract; venue formats never leak.
    """
    rows = _request(env, "GET", "/api/v5/account/positions?instType=SWAP")
    if not rows:
        return []

    positions = []
    for p in rows:
        pos = float(p.get("pos", 0))
        if pos == 0:
            continue
        inst_id = p.get("instId", "")
        pos_side = p.get("posSide", "")
        notional = float(p.get("notionalUsd", 0))
        mark_px = float(p.get("markPx") or 0)

        # A non-zero position we cannot value must RAISE, never be skipped: a
        # dropped row reads as flat — the reconciler re-buys on top of it, and
        # a self_ledger close reads "the account holds none of it".
        if mark_px <= 0:
            raise Exception(f"okx position {inst_id}: no markPx on a non-zero position")

        # Determine direction from posSide
        if pos_side == "short":
            side = "short"
        elif pos_side == "long":
            side = "long"
        else:
            # net mode — pos sign determines direction
            side = "short" if pos < 0 else "long"

        # canonical dashless uppercase — reconciler keys on this
        symbol = inst_id[:-5] if inst_id.endswith("-SWAP") else inst_id
        symbol = symbol.replace("-", "").upper()

        # size in base units: pos(contracts) × ctVal (EXACT — notionalUsd/markPx
        # loses precision and under-sizes closes: a 0.001 ETH position read
        # back 0.00099911, floored to 0 contracts, unclosable dust — measured
        # 2026-08-05). The positions response does NOT carry ctVal (verified
        # live: field present but null) — it comes from the public instruments
        # endpoint, cached per instId; lookup failure falls back to the
        # notional derivation.
        ct_val = _ct_val(env, inst_id)
        size = abs(pos) * ct_val if ct_val else notional / mark_px
        positions.append({
            "symbol": symbol,
            "side": side,
            "size": size,
            "mark_price": mark_px,
        })

    return positions


# OKX v5 REST error codes (body `code`, a string). 50004 is an endpoint
# timeout whose outcome is unknown — harmless for a read, which is all the
# reconciler asks this about. 50119 has been seen arriving with HTTP 401.
_TRANSIENT = {"50001", "50004", "50005", "50011", "50013", "50026"}
_CREDENTIAL = {"50007", "50008", "50012", "50027", "50100", "50101", "50105",
               "50110", "50111", "50113", "50114", "50119", "50120", "50121"}
_UNKNOWN = {"50009", "50102", "50112"}  # stop-out freeze; clock skew


def classify(exc) -> str:
    """lib.venue_errors TRANSIENT / CREDENTIAL / UNKNOWN for a failed read.
    Covers this lib's errors and lib/order_okx.OKXError (which carries the
    HTTP status in `code` for a non-JSON reply — a 5xx there is transient)."""
    if venue_errors is None:
        return None  # the reconciler falls back to its own floor
    code, status = venue_errors.split_status(getattr(exc, "code", None))
    return venue_errors.classify(exc, code, status, _TRANSIENT, _CREDENTIAL, _UNKNOWN,
                                 venue_errors.SERVER_ERRORS)


def get_account_id(env: dict) -> str:
    """The OKX account uid the key belongs to (/api/v5/account/config) — lets
    the reconciler notice a key swapped to a different account. Raises when
    the field is missing: a silent None would skip that check."""
    rows = _request(env, "GET", "/api/v5/account/config")
    uid = (rows[0] if rows else {}).get("uid")
    if not uid:
        raise Exception("OKX account/config returned no uid")
    return str(uid)
