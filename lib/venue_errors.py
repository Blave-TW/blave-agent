"""What a failed exchange READ means: TRANSIENT, CREDENTIAL or UNKNOWN.

manager/reconciler.py asks this after every failed get_positions():
  TRANSIENT  — the venue is busy/down or the network blinked. Skip the round,
               retry, never halt (uid 8232, 2026-09-09: 15 min of OKX 50001 /
               50013 used to trip HALT and block entries for four days).
  CREDENTIAL — the venue rejected the key (revoked, expired, IP, permission).
               Only a human fixes that, so the reconciler halts at once.
  UNKNOWN    — anything else. Fail closed: the old three-strikes halt.

Each lib/account_<venue>.py owns its code table in its own classify(exc); this
module is the venue-agnostic floor they all sit on. Tables come from the
venues' official error-code docs, not from ccxt (its maps disagree with the
docs in many places). A code missing from a table is UNKNOWN on purpose — grow
a table only from a code the reconciler logged as "unclassified" AND the
venue documents.
"""
import requests

TRANSIENT, CREDENTIAL, UNKNOWN = "transient", "credential", "unknown"

_STATUS_TRANSIENT = frozenset({408, 429, 502, 503, 504})
SERVER_ERRORS = frozenset(range(500, 600))


def tag(exc, code=None, http_status=None):
    """Attach the venue's code and HTTP status to an exception without
    changing its type or message — every existing `except Exception` and log
    line sees exactly what it saw before."""
    exc.code = code
    exc.http_status = http_status
    return exc


def http_status(exc):
    s = getattr(exc, "http_status", None)
    if s is None:  # requests.HTTPError from raise_for_status()
        s = getattr(getattr(exc, "response", None), "status_code", None)
    return s if isinstance(s, int) and not isinstance(s, bool) else None


def classify(exc, code=None, status=None, transient=(), credential=(), unknown=(),
             transient_status=()):
    """Body code first, HTTP status as fallback: a clock-skew code arrives
    with HTTP 401 on some venues and must stay UNKNOWN, not CREDENTIAL — so a
    code listed in any table wins over the status. Codes compare as str.
    `status` defaults to the one attached to the exception."""
    if isinstance(exc, (requests.exceptions.Timeout, requests.exceptions.ConnectionError)):
        return TRANSIENT
    if code is not None:
        c = str(code)
        if c in transient:
            return TRANSIENT
        if c in credential:
            return CREDENTIAL
        if c in unknown:
            return UNKNOWN
    s = status if status is not None else http_status(exc)
    if s is not None:
        if s in transient_status or s in _STATUS_TRANSIENT:
            return TRANSIENT
        if s == 401:
            return CREDENTIAL
    return UNKNOWN


def split_status(code):
    """order_okx / order_gateio / order_binance put the HTTP status into
    `code` when the reply is not JSON. An int in 100..599 is that status;
    anything else is the venue's own code. Returns (code, status)."""
    if isinstance(code, int) and not isinstance(code, bool) and 100 <= code <= 599:
        return None, code
    return code, None
