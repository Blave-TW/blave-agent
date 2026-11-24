"""
SinoPac (永豐期貨) domestic futures (TXF / MXF / TMF) order library, relayed
through lib/sinopac_worker.py. NOT live-verified — see the section comment
below. Futures only: Blave never orders TW stocks, and the odd-lot (零股)
stock path this file used to carry was removed (Wei 2026-11-17).

Companion to references/sinopac-broker.md (account setup / CA certificate).
Credentials in .env (the names odd-lot machines were bound with, locked):
sinopac_api_key, sinopac_secret_key, sinopac_ca_path, sinopac_ca_passwd,
optional sinopac_person_id, SINOPAC_LIVE. Only lib/sinopac_worker.py reads
them; this module never logs in.
"""

import json
import logging
import math
import os
import re
import time
import uuid
from hashlib import sha1

from lib import guard, venue_traits
from lib.winreplace import atomic_replace

try:
    from lib import tw_clock
except ImportError:  # half-updated workspace: entries refuse on the clock (_submit_futures)
    tw_clock = None

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)


class SinopacError(Exception):
    """Raised when an order is refused or the worker reports an unexpected state."""

    def __init__(self, msg="", code=None):
        super().__init__(msg)
        self.code = code


class OrderNotConfirmed(Exception):
    """Order was sent but never acknowledged by the exchange within timeout.
    It MAY still go through — query again before resubmitting."""


# ── domestic futures (TXF / MXF / TMF) — relayed through lib/sinopac_worker.py ─
#
# Tested with a faked SDK (tests/check_sinopac_futures.py); M0-b (2026-11-16) ran
# the raw SDK calls once and the 2026-11-23 desktop runs placed and closed a TMF
# lot twice (references/sinopac-broker.md). While the sinopac row of
# lib/venue_traits has no "futures" mode every order is refused before anything
# is written (FUTURES_VERIFIED).
#
# One login per national id is shared by every Shioaji client of that person
# (5 connections), so the futures login lives in lib/sinopac_worker.py and
# futures orders are handed to it as request files. Quantities are 口 (lots);
# symbols are the canonical roots, the worker picks the month contract among
# the months the caller's book holds (book_months; the month already held for an
# entry, else the computed near month — lib/president_contracts is the TAIFEX
# calendar, not a 統一 rule), never a month the user holds on their own, and
# refuses a reduce the live position does not cover.
#
# A request is taken by exactly one side: the worker renames .req → .taken
# before sending, this side renames .req → .cancelled when it gives up. A
# request that timed out after the worker took it may have been sent —
# OrderNotConfirmed, never resubmitted blind.
#
# Gates, in order, before a request file is written: verified, the restart stop
# and the HALT freeze (guard.check_restart_stop — under HALT nothing goes out
# but the user's explicit close), the account hold, an entry's
# guard.entry_blocked, an entry's lib/tw_clock.entry_hold (outside the regular
# session or on a clock past SKEW_BLOCK_S). The worker checks the restart stop,
# the HALT freeze (which already refuses every entry there), the account hold
# and the entry hold again at send time; the HALT close pass and the close-all
# pass held here travel in the request, for a reduce only. Market IOC; a Failed
# MKT with no fill goes once more as MKP IOC there.
# 永豐's own refusal of a sent order (the worker's from_broker) while the weekly session table says
# shut is SessionClosed(from_broker=True; message and code are 永豐's): manager/flatten words it
# [order_reject:market_closed]. No 永豐 code for a shut market is documented or measured.
#
# The broker's position read lags a fill (M0-b: [] right after a Filled order). The
# worker writes lib/sinopac_vault's marker before every send and answers a request
# that arrives inside ORDER_SETTLE_S of it, with too little time left to wait, as
# 'deferred' (SnapshotNotSettled, nothing sent). The fill itself is the response's
# fill_qty — book from that, not from the next position read.
#
# No native stop / take-profit (Shioaji's touch-price order lives client-side):
# place_stop_order refuses. No limit layer — no place_limit_order at all, so
# lib/execute's chase degrades to market, loudly, as for 群益 and 統一.

FUTURES_VERIFIED = "futures" in venue_traits.verified_modes("sinopac")
UNVERIFIED = "unverified"

FUT_ROOTS = ("TXF", "MXF", "TMF")
_WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORDERS_DIR = os.path.join(_WS, "state", "sinopac_orders")
# lib/sinopac_worker.py early-ticks on this (same path derivation there)
REFRESH_FLAG = os.path.join(_WS, "state", "sinopac_refresh")
WORKER_HEARTBEAT = os.path.join(_WS, "state", "heartbeat", "sinopac_worker")
WORKER_STALE_S = 30
_FUT_TAG_RE = re.compile(r"^[A-Za-z0-9]{1,6}$")


class WorkerUnavailable(SinopacError):
    """lib/sinopac_worker.py is not running — nothing was sent."""


class SessionClosed(SinopacError):
    """An entry outside the TAIFEX regular session or on a clock off past SKEW_BLOCK_S —
    nothing was sent (from_broker False). from_broker True: 永豐 refused an order this machine
    sent while the weekly session table (lib/tw_clock.queued_until) says the market is shut."""
    from_broker = False


class SnapshotNotSettled(SinopacError):
    """The previous send on this machine is under ORDER_SETTLE_S old, so the worker's position
    read cannot show it yet — nothing was sent; ask again next round."""


def _worker_alive():
    try:
        age = time.time() - os.path.getmtime(WORKER_HEARTBEAT)
    except OSError:
        raise WorkerUnavailable("永豐 futures worker (lib/sinopac_worker.py) is not running — "
                                "nothing sent")
    if age > WORKER_STALE_S:
        raise WorkerUnavailable(f"永豐 futures worker heartbeat is {int(age)}s old — nothing sent")


def _write_request(req):
    os.makedirs(ORDERS_DIR, exist_ok=True)
    path = os.path.join(ORDERS_DIR, f"{req['id']}.req.json")
    tmp = os.path.join(ORDERS_DIR, f".{req['id']}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(req, f)
    atomic_replace(tmp, path)  # the worker only lists *.req.json: never sees a half-written file
    _request_snapshot_refresh()
    return path


def _request_snapshot_refresh():
    """Ask the worker for an early re-read; it starts no sooner than ORDER_SETTLE_S after the last
    send (manager/flatten calls this while it waits for the snapshot to catch up)."""
    try:
        with open(REFRESH_FLAG, "w"):
            pass
    except OSError:
        pass


def _await_response(req_id, timeout):
    base = os.path.join(ORDERS_DIR, req_id)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(base + ".resp.json", encoding="utf-8") as f:
                resp = json.load(f)
        except (OSError, ValueError):
            time.sleep(0.2)
            continue
        for ext in (".resp.json", ".taken"):  # answered: nothing reads them again
            try:
                os.remove(base + ext)
            except OSError:
                pass
        return resp
    try:
        os.rename(base + ".req.json", base + ".cancelled")
        return None  # never taken: nothing was sent
    except OSError:
        pass
    e = OrderNotConfirmed(f"永豐 worker took request {req_id} but did not answer within "
                          f"{timeout}s — it MAY have been sent; check positions before resending")
    e.contract = None  # the worker picks the month: not known here
    raise e


def _market_shut():
    """The weekly session table (corrected clock; holidays not known) says the market is shut, the
    pre-open included. 永豐 documents no session-closed code (Shioaji's Failed carries only a msg),
    so a broker refusal then is read as the shut market, the 群益 rule (Wei 11-16). An unreadable
    clock is not shut: the refusal stays a plain failure."""
    try:
        return tw_clock is not None and tw_clock.queued_until() is not None
    except Exception:
        return False


def _submit_futures(fields, client_tag, timeout, book_months=None):
    """The one path a futures order leaves this process through."""
    if not FUTURES_VERIFIED:
        guard.audit("order_denied_unverified", **fields)
        raise SinopacError(f"永豐期貨下單程式還沒通過真帳驗證，{fields['symbol']} 的單沒有送出"
                           f"（{fields['intent']}）", code=UNVERIFIED)
    guard.check_restart_stop(fields["intent"], fields)
    guard.check_account_hold("sinopac", fields["intent"], fields)
    if fields["intent"] == "entry" and guard.entry_blocked():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for {fields['symbol']} refused "
            f"before reaching 永豐. Only the user may clear the halt.")
    if fields["intent"] == "entry":
        hold = tw_clock.entry_hold() if tw_clock else {"why": "clock", "skew": float("nan")}
        if hold is not None:
            guard.audit("order_denied_session", why=hold["why"], **fields)
            why = (f"this machine's clock is {hold['skew']:+.0f} s off the api's" if hold["why"] == "clock"
                   else "outside the TAIFEX regular session (it would queue to the open)")
            raise SessionClosed(f"永豐 entry {fields['symbol']} not sent: {why}", code=hold["why"])
    _worker_alive()
    req = dict(fields, id=uuid.uuid4().hex, client_tag=client_tag,
               halt_close_pass=fields["intent"] == "reduce" and guard.halt_closes_allowed(),
               close_all_pass=fields["intent"] == "reduce" and guard.close_all_granted(),
               book_months=None if book_months is None else sorted({str(m) for m in book_months}),
               created_at=time.time(), expires_at=time.time() + timeout)
    guard.audit("order_attempt", **fields)
    _write_request(req)
    resp = _await_response(req["id"], timeout + 30)
    if resp is None:
        guard.audit("order_error", error="worker did not take the request", **fields)
        raise WorkerUnavailable(f"永豐 worker did not take the {fields['symbol']} order within "
                                f"{timeout}s — nothing sent")
    if resp.get("status") == "deferred":
        raise SnapshotNotSettled(f"永豐 {fields['symbol']} not sent: {resp.get('error')}")
    if resp.get("status") == "rejected":
        if resp.get("from_broker") and _market_shut():
            # message and code are 永豐's own (its status text and order status): manager/flatten
            # shows them as the broker's reply, never our wording
            e = SessionClosed(str(resp.get("error") or "rejected"),
                              code=resp.get("broker_status") or "Failed")
            e.from_broker = True
            raise e
        if resp.get("from_broker"):
            raise SinopacError(f"永豐 refused the order: {resp.get('error')}")
        # the worker's own check (nothing held, request expired, tag already sent…): not 永豐's
        raise SinopacError(f"Blave 沒送出這筆單：{resp.get('error')}")
    if resp.get("status") == "unknown":
        e = OrderNotConfirmed(f"永豐 place_order did not answer ({resp.get('error')}) — it MAY "
                              f"have been sent; check positions before resending")
        e.contract = resp.get("symbol")
        raise e
    return resp


def place_futures_market_order(env, symbol, action, lots, intent, client_tag=None,
                               confirm_timeout=30, book_months=None):
    """One market IOC order for TXF / MXF / TMF, relayed to the worker.

    action 'buy'|'sell'; lots int ≥ 1; intent 'entry'|'reduce' (required —
    'reduce' is close-only and refused when the held position does not cover
    it); client_tag ≤6 alphanumeric chars, refused by the worker when already
    sent today. book_months: the contract months ('2026-12') the caller's book
    holds for this root — the worker trades only those, and an empty set means
    none; another held month is the user's own and is never closed, added to or
    opened into. None (no book): the TAIFEX calendar decides, as
    lib/president_contracts.bot_rows.

    Returns {'status': 'filled'|'sent', 'symbol' (month contract), 'fill_qty',
    'avg_fill_price', 'seqno', 'ordno', 'simulation'}. 'sent' = accepted with
    no fill seen in time (an IOC the market did not take) — never resubmit
    on it. Raises SinopacError on refusal, SnapshotNotSettled inside the previous
    send's settle window, guard.Halted on a gate, OrderNotConfirmed when the
    outcome is unknown."""
    if action not in ("buy", "sell"):
        raise ValueError(f"action must be 'buy' or 'sell', got {action!r}")
    if intent not in ("entry", "reduce"):
        raise ValueError(f"intent must be 'entry' or 'reduce', got {intent!r}")
    lots = int(lots)
    if lots < 1:
        raise ValueError(f"lots must be >= 1, got {lots}")
    sym = str(symbol).upper()
    if sym not in FUT_ROOTS:
        raise ValueError(f"symbol must be TXF/MXF/TMF (the worker picks the month), got {symbol!r}")
    if client_tag is not None and not _FUT_TAG_RE.match(str(client_tag)):
        raise ValueError(f"client_tag must be 1-6 alphanumeric chars, got {client_tag!r}")
    fields = {"venue": "sinopac", "market": "futures", "symbol": sym, "action": action,
              "qty": lots, "unit": "lots", "intent": intent}
    result = _submit_futures(fields, client_tag, confirm_timeout, book_months)
    logging.info(f"sinopac {action} {result.get('symbol')} {lots} lots → {result.get('status')} "
                 f"filled={result.get('fill_qty')}")
    return result


def _below_one_lot(qty):
    from lib import reject_token   # the token is what flatten and close_symbol count as dust
    return ValueError(reject_token.tag(reject_token.BELOW_MIN_SIZE,
                                       f"sinopac: {qty} lots is below the 1-lot minimum"))


def format_qty(env: dict, symbol: str, qty: float, price: float = None) -> str:
    """Lots are whole numbers; below 1 lot raises ValueError (flatten's dust-skip signal)."""
    if float(qty) < 1:
        raise _below_one_lot(qty)
    return str(math.floor(float(qty) + 0.5))


def close_position_partial(env: dict, symbol: str, direction: str, qty: float,
                           client_order_id: str = None, book_months=None):
    """Close-only exit of `qty` lots of the futures position held in `symbol`
    (TXF / MXF / TMF); `direction` is the position being closed; book_months as in
    place_futures_market_order (manager/flatten passes the book's). status 'unknown' (as 統一's):
    the worker took it and its outcome never came back — it may have filled."""
    lots = math.floor(float(qty) + 0.5)  # round-half-up, as the reconciler; NOT round()
    if lots < 1:
        raise _below_one_lot(qty)
    tag = None
    if client_order_id:
        cid = str(client_order_id)
        tag = cid if _FUT_TAG_RE.match(cid) else "c" + sha1(cid.encode()).hexdigest()[:5]
    try:
        result = place_futures_market_order(env, symbol, "sell" if direction == "long" else "buy",
                                            lots, intent="reduce", client_tag=tag,
                                            book_months=book_months)
    except OrderNotConfirmed as e:
        logging.error(f"sinopac close {symbol} {lots} lots: outcome unknown — {e}")
        result = {"status": "unknown", "fill_qty": 0.0, "symbol": getattr(e, "contract", None),
                  "error": str(e)}
    return {"avg_price": result.get("avg_fill_price") or 0.0,
            "executed_qty": result.get("fill_qty") or 0.0,
            "exchange": "sinopac",
            "resolved_symbol": result.get("symbol"),
            "status": result.get("status"),
            "broker_status": result.get("broker_status"),
            "seqno": result.get("seqno"),
            "ordno": result.get("ordno")}


# ── not verified — deliberately unimplemented ────────────────────────────────

_NOT_VERIFIED = ("not verified on 永豐 — only market IOC entries and close-only exits are "
                 "written; implement from a user-approved live run, not from the docs alone.")


def cancel_order(*_args, **_kwargs):
    raise NotImplementedError(f"cancel_order is {_NOT_VERIFIED}")


def modify_order(*_args, **_kwargs):
    raise NotImplementedError(f"modify_order is {_NOT_VERIFIED}")


def place_stop_order(*_args, **_kwargs):
    """停損 — Shioaji's touch-price order lives in the client process, not at the broker."""
    raise NotImplementedError("永豐 has no broker-side stop order (Shioaji's touch-price order runs "
                              "client-side) — references/sinopac-broker.md")
