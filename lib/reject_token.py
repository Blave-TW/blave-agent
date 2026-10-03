"""`[order_reject:<kind>]` — what kind of order rejection an error message is.

The desktop app and the web page read only this token, never a venue's codes or
English text (two readers of raw codes drift apart). Each lib/order_<venue>.py
decides the kind from its own code table and puts the token at the FRONT of the
message: manager/order_errors.json keeps only the first 200 characters
(lib/portfolio._record_order_error, which also moves a token that a caller's
prefix pushed back to the front). A message without a token is shown as is.

Kinds and the codes behind them come only from the venues' official error docs
or a measured live reply — a code that could not be verified is not classified.
"""
import re

INSUFFICIENT_MARGIN = "insufficient_margin"
BELOW_MIN_SIZE = "below_min_size"
SYMBOL_UNAVAILABLE = "symbol_unavailable"
KEY_PERMISSION = "key_permission"
REDUCE_ONLY_REJECTED = "reduce_only_rejected"
PAPER_MARGIN = "paper_margin"
KINDS = (INSUFFICIENT_MARGIN, BELOW_MIN_SIZE, SYMBOL_UNAVAILABLE, KEY_PERMISSION,
         REDUCE_ONLY_REJECTED, PAPER_MARGIN)

_TOKEN_RE = re.compile(r"\[order_reject:([a-z_]+)\] ?")


def tag(kind, msg):
    """msg with the kind's token in front; an unknown or empty kind leaves it as is."""
    msg = str(msg)
    if kind not in KINDS or _TOKEN_RE.match(msg):
        return msg
    return f"[order_reject:{kind}] {msg}"


def plain(msg):
    """The message with its token removed (notices people read)."""
    return _TOKEN_RE.sub("", str(msg), count=1)


def to_front(msg):
    """Move a token that is not at the start (a caller wrote "close_symbol: {e}")
    to the start, so truncation can't cut it off."""
    msg = str(msg)
    m = _TOKEN_RE.search(msg)
    if not m or m.start() == 0:
        return msg
    return m.group(0).rstrip() + " " + (msg[:m.start()] + msg[m.end():]).strip()


def from_code(code, table, credential=()):
    """Kind for a venue's error code: its own table first, then the account lib's
    credential set (a rejected key). Codes compare as str."""
    if code is None:
        return None
    c = str(code)
    if c in table:
        return table[c]
    return KEY_PERMISSION if c in credential else None


def credential_codes(venue):
    """The account lib's _CREDENTIAL set (the same codes the reconciler halts on);
    empty if that lib can't be imported — the message then just goes untagged."""
    try:
        import importlib
        return frozenset(str(c) for c in getattr(importlib.import_module(f"lib.account_{venue}"), "_CREDENTIAL", ()))
    except Exception:
        return frozenset()
