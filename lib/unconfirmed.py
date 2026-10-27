"""Orders the venue took whose outcome is not known — parked until it is.

Under self_ledger a fill that was never confirmed is missing from the book, so the
next round would send the same order again and double the position. An order lib
that has the venue's order id but cannot confirm the outcome raises a subclass of
OrderOutcomeUnknown; lib/portfolio.reconcile parks it here, holds that one symbol
(entries and reduces; every other symbol trades on), and each round queries the
order by id first: a fill is booked from the venue's numbers, a terminal no-fill
releases it, anything else keeps it parked. Never a HALT. One reminder after
REMIND_AFTER_S; after that only resolve() — the user read the position on the
venue and told the agent — or a query that finally answers releases it.
canon notifications.md §3 `order_unconfirmed`.

Stdlib only, no lib/portfolio import at module level (portfolio imports this).
"""
import json
import logging
import os
import time
from contextlib import contextmanager
from datetime import datetime

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
try:
    import msvcrt
except ImportError:  # POSIX
    msvcrt = None
try:
    from lib.winreplace import atomic_replace, load_json
except ImportError:  # half-updated workspace
    atomic_replace = os.replace

    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)

PATH = "state/order_unconfirmed.json"
LOCK_PATH = "state/order_unconfirmed.lock"
REMIND_AFTER_S = 3600


class OrderOutcomeUnknown(Exception):
    """Base of every order lib's OrderNotConfirmed that can be parked: the venue
    accepted the order (or may have) and its outcome is not known. The order MAY
    HAVE FILLED — query it, never resubmit blindly. venue / venue_symbol /
    order_id are what the reconciler needs to query it later; without them the
    order cannot be parked and is reported as a plain order failure."""

    def __init__(self, msg, venue=None, venue_symbol=None, order_id=None):
        super().__init__(msg)
        self.venue = venue
        self.venue_symbol = venue_symbol
        self.order_id = order_id

    def parkable(self):
        return bool(self.venue and self.venue_symbol and self.order_id)


class ParkUnreadable(RuntimeError):
    """The park file exists but cannot be read: which orders are parked is
    unknown, so nothing is sent this round (fail-closed)."""


@contextmanager
def _locked():
    os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
    with open(LOCK_PATH, "a+") as fh:
        if fcntl is not None:
            fcntl.flock(fh, fcntl.LOCK_EX)
        elif msvcrt is not None:
            deadline = time.time() + 30
            while True:
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    if time.time() > deadline:
                        raise
        yield


def _read():
    try:
        rows = load_json(PATH)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        # never set aside: this file is the only record of a possibly-filled order
        raise ParkUnreadable(f"{PATH} unreadable ({type(e).__name__})") from e
    if not isinstance(rows, dict):
        raise ParkUnreadable(f"{PATH} is not an object")
    return rows


def _write(rows):
    if not rows:
        try:
            os.remove(PATH)
        except FileNotFoundError:
            pass
        return
    tmp = f"{PATH}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(rows, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    atomic_replace(tmp, PATH)


def load():
    """{book_key: entry}; {} when none. Raises ParkUnreadable."""
    with _locked():
        return _read()


def park(key, err, signed_diff, reduce_only, asset_spec=None, contributors=None, now=None):
    with _locked():
        rows = _read()
        rows[key] = {
            "venue": err.venue, "venue_symbol": err.venue_symbol, "order_id": str(err.order_id),
            "signed_diff": signed_diff, "reduce_only": bool(reduce_only),
            "asset_spec": asset_spec, "contributors": contributors or [],
            "parked_at": time.time() if now is None else now,
            "at": datetime.utcnow().isoformat(), "reads": 0, "reminded": False,
            "error": str(err)[:200],
        }
        _write(rows)


def update(key, expect_order_id, **fields):
    """Set fields on a parked entry — only if it is still the same order (resolve()
    in another process may have released it meanwhile). False = gone or replaced."""
    with _locked():
        rows = _read()
        row = rows.get(key)
        if not row or row.get("order_id") != expect_order_id:
            return False
        row.update(fields)
        _write(rows)
        return True


def release(key, expect_order_id=None):
    """Drop a parked entry. False = it was not there (or is another order) — the
    caller must then not book anything: someone else already settled it."""
    with _locked():
        rows = _read()
        row = rows.get(key)
        if not row or (expect_order_id is not None and row.get("order_id") != expect_order_id):
            return False
        del rows[key]
        _write(rows)
        return True


def outcome(order, terminal):
    """A venue lib's normalized get_order() dict → (executed_qty, avg_price) once the
    order is terminal (qty 0 = ended without a fill), None while not known."""
    if not isinstance(order, dict) or order.get("status") not in terminal:
        return None
    qty = float(order.get("executed_qty") or 0)
    price = float(order.get("avg_price") or 0)
    if qty > 0 and price <= 0:
        return None  # a fill without its price cannot be booked
    return qty, price


def resolve(symbol, filled_qty, avg_price=None):
    """The user checked the venue: book what filled (base units, the venue's average
    fill price — required when anything filled) and release the symbol. 0 = nothing
    filled. Returns the released entry. For the agent, after the user has said how
    much filled; never guess the numbers."""
    filled_qty = abs(float(filled_qty))
    if filled_qty > 0 and not (avg_price and float(avg_price) > 0):
        raise ValueError("avg_price is required when anything filled — the book needs the cost")
    from lib.portfolio import book_unconfirmed, market_key, split_key

    def canon(k):
        sym, market = split_key(str(k))
        return market_key(sym.replace("-", "").upper(), market)

    rows = load()
    key = next((k for k, v in rows.items()
                if canon(k) == canon(symbol) or v.get("venue_symbol") == symbol), None)
    if key is None:
        raise KeyError(f"{symbol} has no parked order")
    entry = rows[key]
    if not release(key, entry["order_id"]):
        raise KeyError(f"{symbol}: the parked order was settled meanwhile")
    if filled_qty > 0:
        book_unconfirmed(key, entry, filled_qty, float(avg_price), source="user")
    logging.info(f"[unconfirmed] {key} order {entry['order_id']} resolved by the user: "
                 f"filled {filled_qty:g}")
    return entry
