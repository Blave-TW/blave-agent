"""Orders the venue took (or may have) whose outcome is not known — parked until it is.

Under self_ledger a fill that was never confirmed is missing from the book, so the
next round would send the same order again and double the position. An order lib
that cannot confirm an order it sent raises a subclass of OrderOutcomeUnknown
carrying the venue's order id and/or our client order id; lib/portfolio parks it
here. While parked, its symbol gets no entry legs; reduce-only closes of what the
book holds still go out (stops keep working). Each round the order is queried
first: a fill is booked from the venue's numbers, a terminal no-fill releases it,
anything else keeps it parked — never a HALT. A reminder after REMIND_AFTER_S,
then every REMIND_EVERY_S. resolve() is the agent's way out after the user read
the position on the venue. An unknown outcome that cannot be parked (no ids, or
this file cannot be written) is a HALT instead (lib/portfolio.park_or_halt).
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
REMIND_EVERY_S = 86400


class OrderOutcomeUnknown(Exception):
    """Base of every order lib's OrderNotConfirmed: the venue accepted the order (or
    may have) and its outcome is not known. The order MAY HAVE FILLED — query it,
    never resubmit blindly. venue / venue_symbol and order_id or client_order_id are
    what the reconciler needs to query it later; without them it cannot be parked."""

    def __init__(self, msg, venue=None, venue_symbol=None, order_id=None, client_order_id=None):
        super().__init__(msg)
        self.venue = venue
        self.venue_symbol = venue_symbol
        self.order_id = order_id
        self.client_order_id = client_order_id

    def parkable(self):
        return bool(self.venue and self.venue_symbol and (self.order_id or self.client_order_id))


class ParkUnreadable(RuntimeError):
    """The park file exists but cannot be read: which orders are parked is
    unknown, so nothing is sent this round (fail-closed)."""


def park_id(entry_or_err):
    """One id per parked order: the venue's order id, else ours."""
    g = entry_or_err.get if isinstance(entry_or_err, dict) else lambda k: getattr(entry_or_err, k, None)
    return str(g("order_id")) if g("order_id") else f"cid:{g('client_order_id')}"


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
    """{park_id: entry} (entry['key'] = the book key); {} when none. Raises ParkUnreadable."""
    with _locked():
        return _read()


def held_keys(rows):
    return {e.get("key") for e in (rows or {}).values() if isinstance(e, dict) and e.get("key")}


def park(key, err, signed_diff, reduce_only, asset_spec=None, contributors=None, now=None,
         netted_room=0.0, netted_exit=False):
    """Raises OSError when the file cannot be written — the caller HALTs then."""
    pid = park_id(err)
    with _locked():
        rows = _read()
        rows[pid] = {
            "key": key, "venue": err.venue, "venue_symbol": err.venue_symbol,
            "order_id": str(err.order_id) if err.order_id else None,
            "client_order_id": err.client_order_id or None,
            "signed_diff": signed_diff, "reduce_only": bool(reduce_only),
            "asset_spec": asset_spec, "contributors": contributors or [],
            "netted_room": float(netted_room or 0), "netted_exit": bool(netted_exit),
            "parked_at": time.time() if now is None else now,
            "at": datetime.utcnow().isoformat(), "reads": 0, "reminded_at": None,
            "error": str(err)[:200],
        }
        _write(rows)
    return pid


def update(pid, **fields):
    """Set fields on a parked entry — only if it is still there (resolve() in another
    process may have released it meanwhile). False = gone."""
    with _locked():
        rows = _read()
        row = rows.get(pid)
        if not row:
            return False
        row.update(fields)
        _write(rows)
        return True


def release(pid):
    """Drop a parked entry. False = it was not there (someone else settled it)."""
    with _locked():
        rows = _read()
        if pid not in rows:
            return False
        del rows[pid]
        _write(rows)
        return True


def settle(pid, book):
    """Book a parked order's outcome, then release it — both under the park lock, so the
    reconciler and resolve() never both book it. book() runs only while the entry is
    still parked; a crash after it but before the release re-runs it next round, which
    is why lib/portfolio.book_unconfirmed skips a park id the book already has. False =
    it was already settled."""
    with _locked():
        rows = _read()
        if pid not in rows:
            return False
        book(rows[pid])
        del rows[pid]
        _write(rows)
        return True


def remind_due(entry, now):
    """True when the parked order is owed a reminder: first after REMIND_AFTER_S,
    then every REMIND_EVERY_S."""
    last = entry.get("reminded_at")
    if last is None and entry.get("reminded") is True:  # a park written before reminded_at
        last = float(entry.get("parked_at") or now) + REMIND_AFTER_S
    if last is None:
        return now - float(entry.get("parked_at") or now) >= REMIND_AFTER_S
    return now - float(last) >= REMIND_EVERY_S


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
    fill price — required when anything filled) and release the symbol's parked
    order. 0 = nothing filled. Returns the released entry. For the agent, after the
    user has said how much filled; never guess the numbers. One parked order per
    call (the oldest on that symbol)."""
    filled_qty = abs(float(filled_qty))
    if filled_qty > 0 and not (avg_price and float(avg_price) > 0):
        raise ValueError("avg_price is required when anything filled — the book needs the cost")
    from lib.portfolio import book_unconfirmed, market_key, split_key

    def canon(k):
        sym, market = split_key(str(k))
        return market_key(sym.replace("-", "").upper(), market)

    rows = load()
    hits = sorted(((e.get("parked_at") or 0, pid) for pid, e in rows.items()
                   if canon(e.get("key")) == canon(symbol) or e.get("venue_symbol") == symbol))
    if not hits:
        raise KeyError(f"{symbol} has no parked order")
    pid = hits[0][1]
    entry = rows[pid]

    def book(e):
        if filled_qty > 0:
            book_unconfirmed(e["key"], e, filled_qty, float(avg_price), source="user", pid=pid)

    if not settle(pid, book):
        raise KeyError(f"{symbol}: the parked order was settled meanwhile")
    logging.info(f"[unconfirmed] {entry['key']} park {pid} resolved by the user: filled {filled_qty:g}")
    return entry
