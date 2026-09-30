"""
President Futures (統一期貨) domestic futures orders — Unitrade API (`pip
install unitrade`). TXF / MXF / TMF market orders only. Companion reference:
references/president-broker.md (read it before any 統一 work).

Taiwan-broker shape, like lib/order_capital.py (NOT lib/order_TEMPLATE.py's
perp contract): quantities are 口 (lots), symbols are the canonical roots
TXF / MXF / TMF, the lib maps them to a month contract (TXFJ6 = TXF, J=Oct, 6=2026).

Design rules:
1. ENTRY → COMPUTED NEAR MONTH, CLOSE → THE ROW'S OWN CONTRACT. Contracts
   settle at 13:30 Taipei on the third Wednesday of their month (the instant
   the backtest's TXFR1 series changes contract). An entry goes to the month
   the day session opens on, i.e. from 08:45 on settlement day entries go to
   the next month (entry_roll_at — why: see there). The computed contract must
   appear in the broker's get_domestic_contracts list, else the order is
   refused. A reduce/close goes to the productid of the position row it closes
   (lib/account_president's snapshot) with opencloseflag "1" (close only), and
   only after the snapshot confirms the side and the size: a reduce that would
   add to or reverse a position, or a snapshot older than this contract's last
   order, is refused before the login. NOT verified across a real settlement day.
2. SENT ≠ ACCEPTED ≠ FILLED. order() returning issend=True only means the
   request left this machine. Accepted = an on_reply for OUR seq with
   statuscode '0000' (or a fill code 0003/0004). A fill = on_match rows for
   the orderno that reply carried (on_match has no seq). No fill seen within
   confirm_timeout returns status 'sent' with fill_qty 0 — an IOC the market
   did not take, or a fill not yet reported; the IOC-cancel report has never
   been observed (the test host never fills). Never resubmit on 'sent'.
3. NO CLIENT ORDER ID AT THE BROKER. `note` (≤10 chars) is only a label. A
   client_tag is refused locally if it was already sent today
   (state/president_order_tags.json, recorded once the broker took the send,
   under a cross-process lock held from the check to the record). A process
   killed between the send and the record leaves the tag reusable — the
   snapshot check on reduces is the backstop there.
4. HALTABLE + AUDITED. guard.check_restart_stop first, then HALT blocks
   entries (closes always pass); every send audits order_sent / order_error /
   order_filled.
5. ONE SESSION PER CALL, ALWAYS LOGGED OUT. Unitrade starts non-daemon
   threads at login; a process that skips logout() never exits. Concurrent
   logins with the worker's session were measured fine on the test host.
6. NO BROKER ATTRIBUTION, NO NATIVE STOP ORDERS, NO LIMIT LAYER here —
   place_stop_order / cancel_order / modify_order are stubs like
   order_capital's. The chase executor's limit functions are deliberately
   absent (not stubbed): lib.venue_wiring detects the limit layer by hasattr,
   and absence is what makes a chase request fall back to market loudly.

Credentials: president_account / president_password / president_test_url /
president_ca_path / president_ca_password (+ PRESIDENT_LIVE=true and
president_url for production) — resolved by lib/president_vault.py.
"""

import calendar
import json
import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hashlib import sha1

from lib import guard, president_vault

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)

_WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# lib/president_worker.py early-ticks on this (same path derivation there)
_REFRESH_FLAG = os.path.join(_WS, "state", "president_refresh")
_TAGS_PATH = os.path.join(_WS, "state", "president_order_tags.json")
# {productid: unix time of the last send} — read by the reduce check here and by
# manager/reconciler.py's Read-Your-Writes guard
LAST_ORDER_PATH = os.path.join(_WS, "state", "president_last_order_at.json")
SDK_LOG_DIR = os.path.join(_WS, "state", "president_logs")

# fixed UTC+8 (no DST since 1979): Windows Python ships no tz database, ZoneInfo would raise there
TAIPEI = timezone(timedelta(hours=8), "Asia/Taipei")
ROOTS = ("TXF", "MXF", "TMF")
MONTH_CODES = "ABCDEFGHIJKL"  # futures month letters, A = January
SETTLE_HOUR, SETTLE_MINUTE = 13, 30
DAY_OPEN_HOUR, DAY_OPEN_MINUTE = 8, 45
PROD_RE = re.compile(r"^(TXF|MXF|TMF)([A-L])(\d)$")
_TAG_RE = re.compile(r"^[A-Za-z0-9]{1,10}$")
# 0001 = 減量成功 (a quantity reduction) is not terminal; 0002 = 刪單成功 is
_ACCEPTED = {"0000", "0001", "0003", "0004"}
_CANCELED = {"0002"}

_tags_lock = threading.Lock()


class PresidentError(Exception):
    """The broker refused or could not take an order; message carries its code/text."""


class DuplicateOrder(PresidentError):
    """This client_tag was already sent today — refused before reaching the broker."""


# ── near month (rule 1) ──────────────────────────────────────────────────────

def settlement_at(year, month):
    """13:30 Taipei on the third Wednesday of year/month."""
    first = calendar.weekday(year, month, 1)  # Mon=0
    day = 1 + (calendar.WEDNESDAY - first) % 7 + 14
    return datetime(year, month, day, SETTLE_HOUR, SETTLE_MINUTE, tzinfo=TAIPEI)


def entry_roll_at(year, month):
    """08:45 Taipei on settlement day — from then on entries go to the next
    month. A position opened in the expiring contract on its last day is
    cash-settled at 13:30 and the reconciler then re-opens it in the next month:
    two extra round trips of commission and slippage. Rolling at the day
    session's open instead differs from the backtest's TXFR1 (which stays on the
    expiring contract until 13:30) only by the calendar spread's move over those
    ≤4h45m, and closes still go to whatever month is held."""
    return settlement_at(year, month).replace(hour=DAY_OPEN_HOUR, minute=DAY_OPEN_MINUTE)


def prod_id(root, year, month):
    return f"{root}{MONTH_CODES[month - 1]}{year % 10}"


def near_month(root, listed, now=None):
    """The contract an entry goes to at `now` (tz-aware; default: now in
    Taipei). Raises if the computed contract is not in `listed` — the broker's
    own list is the check, never the fallback."""
    root = str(root).upper()
    if root not in ROOTS:
        raise ValueError(f"{root!r} is not TXF/MXF/TMF")
    now = now or datetime.now(TAIPEI)
    if now.tzinfo is None:
        raise ValueError("near_month needs a timezone-aware time")
    y, m = now.astimezone(TAIPEI).year, now.astimezone(TAIPEI).month
    while entry_roll_at(y, m) <= now:
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    want = prod_id(root, y, m)
    listed = [str(x).upper() for x in (listed or [])]
    if want not in listed:
        raise PresidentError(f"near month {want} (settles {settlement_at(y, m):%Y-%m-%d %H:%M}) is not "
                             f"in the broker's contract list {listed} — not trading on a guess")
    return want


def _listed(api, root):
    resp = api.get_domestic_contracts(root, "F")
    if not resp or not resp.ok:
        raise PresidentError(f"get_domestic_contracts({root}) failed: {getattr(resp, 'error', resp)}")
    return [c.prod_id for c in resp.data or []]


def _last_orders():
    try:
        with open(LAST_ORDER_PATH, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def last_order_at(productid=None):
    """Unix time of the last send (for `productid`, or any), 0.0 if none."""
    d = _last_orders()
    vals = [d.get(productid)] if productid else list(d.values())
    return max([float(v) for v in vals if isinstance(v, (int, float))] or [0.0])


def _mark_order_sent(productid):
    d = _last_orders()
    d[productid] = time.time()
    try:
        os.makedirs(os.path.dirname(LAST_ORDER_PATH), exist_ok=True)
        with open(LAST_ORDER_PATH + ".tmp", "w", encoding="utf-8") as f:
            json.dump(d, f)
        os.replace(LAST_ORDER_PATH + ".tmp", LAST_ORDER_PATH)
    except OSError as e:
        logging.warning(f"[president] last-order marker not written: {e}")


def _checked_close(symbol, action, lots):
    """The productid a close of `lots` by `action` goes to — only when the
    snapshot shows a position on the other side, at least that large, read
    after this contract's last order. Anything else is refused (never sent)."""
    from lib.account_president import get_snapshot_read_at, position_rows
    sym = str(symbol).upper()
    if not PROD_RE.match(sym) and sym not in ROOTS:
        raise ValueError(f"{symbol!r} is not TXF/MXF/TMF or a month contract code")
    rows = position_rows()
    hits = [r for r in rows if (r["productid"] == sym if PROD_RE.match(sym) else r["root"] == sym)]
    if not hits:
        raise PresidentError(f"no open {sym} position in the 統一 snapshot — nothing to close")
    if len(hits) > 1:
        raise PresidentError(f"{sym} is open in several months {sorted(r['productid'] for r in hits)} "
                             f"— close each by its contract code, not the root")
    row = hits[0]
    if get_snapshot_read_at() <= last_order_at(row["productid"]):
        raise PresidentError(f"the 統一 snapshot predates the last {row['productid']} order — "
                             f"not closing on positions that may already have changed; retry shortly")
    net = int(row["net"])
    side = "long" if net > 0 else "short"
    if action != ("sell" if net > 0 else "buy"):
        raise PresidentError(f"{row['productid']} is {side} {abs(net)} — a {action} would add to it, "
                             f"not close it; refused")
    if lots > abs(net):
        raise PresidentError(f"closing {lots} lots of {row['productid']} but only {abs(net)} held "
                             f"({side}) — refused rather than open the other side")
    return row["productid"]


# ── local duplicate guard (rule 3) ───────────────────────────────────────────

def _tags_today():
    today = datetime.now(TAIPEI).strftime("%Y-%m-%d")
    try:
        with open(_TAGS_PATH, encoding="utf-8") as f:
            book = json.load(f)
    except (OSError, ValueError):
        book = {}
    return today, (book.get("tags", []) if book.get("date") == today else [])


@contextmanager
def _tag_guard(tag):
    """Check `tag` against today's sends, hold a cross-process lock until the
    caller records it (only once the broker took the order) or gives up."""
    if tag is None:
        yield lambda: None
        return
    os.makedirs(os.path.dirname(_TAGS_PATH), exist_ok=True)
    lock = _TAGS_PATH + ".lock"
    deadline = time.time() + 30
    while True:
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock) > 120:  # holder died mid-send
                    os.remove(lock)
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                raise PresidentError("another order holds the 統一 client_tag book — retry")
            time.sleep(0.1)
    try:
        today, tags = _tags_today()
        if tag in tags:
            raise DuplicateOrder(f"client_tag {tag!r} was already sent today — refused (the broker "
                                 f"has no client order id to deduplicate on)")

        def record():
            tmp = _TAGS_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"date": today, "tags": tags + [tag]}, f)
            os.replace(tmp, _TAGS_PATH)
        yield record
    finally:
        try:
            os.remove(lock)
        except OSError:
            pass


def _tag_for(client_order_id):
    """A ≤10-char note from a caller's id: itself if it fits, else a digest."""
    cid = str(client_order_id)
    return cid if _TAG_RE.match(cid) else "c" + sha1(cid.encode()).hexdigest()[:9]


# ── session + send + confirm ─────────────────────────────────────────────────

@contextmanager
def _session(env):
    # credentials and PRESIDENT_LIVE come from the workspace .env, never from `env`
    api = president_vault.login(president_vault.resolve(), SDK_LOG_DIR)
    try:
        yield api
    finally:
        api.logout()


def _request_snapshot_refresh():
    try:
        with open(_REFRESH_FLAG, "w"):
            pass
    except OSError:
        pass  # the worker's 60 s poll still covers it


class _Reports:
    """on_reply / on_match collector. The SDK hands on_reply the SAME mutable
    object on every update, so fields are copied at callback time."""

    def __init__(self):
        self.lock = threading.Lock()
        self.replies = {}   # seq -> [dict]
        self.matches = {}   # orderno -> {matchseq: (qty, price)}

    def on_reply(self, r):
        row = {k: getattr(r, k, None) for k in
               ("seq", "orderno", "statuscode", "orderstatus", "matchqty", "nomatchqty", "productid")}
        with self.lock:
            self.replies.setdefault(str(row["seq"] or "").strip(), []).append(row)

    def on_match(self, m):
        with self.lock:
            self.matches.setdefault(str(m.orderno), {})[str(m.matchseq)] = (
                int(m.matchqty or 0), float(m.matchprice or 0))

    def latest(self, seq):
        with self.lock:
            rows = self.replies.get(seq) or []
            return dict(rows[-1]) if rows else None

    def fills(self, orderno):
        with self.lock:
            return list((self.matches.get(str(orderno)) or {}).values())


def _check_halt(fields):
    if fields["intent"] == "entry" and guard.halted():
        guard.audit("order_denied_halt", **fields)
        raise guard.Halted(
            f"state/HALT is set ({guard.halt_info()}) — entry order for {fields['symbol']} refused "
            f"before reaching 統一. Closes still work. Only the user may clear the halt.")


def _send(api, obj, reports, fields):
    """The one path an order leaves this machine through."""
    guard.check_restart_stop(fields["intent"], fields)
    api.dtrade.on_reply = reports.on_reply
    api.dtrade.on_match = reports.on_match
    _mark_order_sent(obj.productid)
    resp = api.dtrade.order(obj)
    if not resp.issend:
        # a signing failure's text carries the national id — never pass it on raw
        err = president_vault.sanitize(resp.errormsg)
        guard.audit("order_error", code=resp.errorcode, error=err, **fields)
        raise PresidentError(f"order not sent: {resp.errorcode} {err}")
    seq = str(resp.seq).strip()
    guard.audit("order_sent", seq=seq, **fields)
    _request_snapshot_refresh()
    return seq


def _await(reports, seq, lots, timeout, fields):
    deadline = time.time() + timeout
    ack = None
    while time.time() < deadline:
        ack = reports.latest(seq)
        if ack and ack["statuscode"] not in (None, "", "STAR"):
            break
        time.sleep(0.05)
    code = (ack or {}).get("statuscode")
    if ack and code not in _ACCEPTED and code not in _CANCELED:
        err = president_vault.sanitize(ack.get("orderstatus"))
        guard.audit("order_error", seq=seq, code=code, error=err, **fields)
        raise PresidentError(f"統一 rejected the order: statuscode={code} {err}")
    orderno = (ack or {}).get("orderno")
    settled_at = None
    while orderno and time.time() < deadline:
        filled = sum(q for q, _ in reports.fills(orderno))
        if filled >= lots:
            break
        if filled or (reports.latest(seq) or {}).get("statuscode") in _CANCELED:
            # a partial fill or the IOC remainder's cancel: 1 s for trailing match rows
            settled_at = settled_at or time.time()
            if time.time() - settled_at >= 1.0:
                break
        time.sleep(0.05)
    rows = reports.fills(orderno) if orderno else []
    qty = sum(q for q, _ in rows)
    avg = sum(q * p for q, p in rows) / qty if qty else 0.0
    last = reports.latest(seq) or {}
    # the reply's own matchqty floors the fill: a match row that never arrived must
    # not turn a filled order into 'sent' (that reads as unfilled and invites re-entry)
    replied = int(last.get("matchqty") or 0)
    if replied > qty:
        qty, avg = replied, (avg if rows else 0.0)
    return {"seq": seq, "orderno": orderno, "status": "filled" if qty else "sent",
            "symbol": fields["symbol"], "fill_qty": float(qty), "avg_fill_price": avg,
            "ack": code, "statuscode": last.get("statuscode")}


def place_futures_market_order(env, symbol, action, lots, intent, client_tag=None,
                               confirm_timeout=15):
    """One market IOC order.

    symbol: TXF / MXF / TMF — an entry goes to the computed near month with
    opencloseflag "" (broker decides); a reduce goes to the held row's
    productid with opencloseflag "1" (close only), after _checked_close (a
    month code like TXFJ6 is also accepted for a reduce). action:
    'buy'|'sell'. lots: int ≥ 1. intent: 'entry'|'reduce', REQUIRED ('entry'
    is HALT-blocked). client_tag: ≤10 alphanumeric chars, refused if already
    sent today.

    Returns {'status': 'filled'|'sent', 'symbol' (the month contract),
    'fill_qty', 'avg_fill_price', 'seq', 'orderno', 'ack'}; raises
    PresidentError on refusal."""
    if action not in ("buy", "sell"):
        raise ValueError(f"action must be 'buy' or 'sell', got {action!r}")
    if intent not in ("entry", "reduce"):
        raise ValueError(f"intent must be 'entry' or 'reduce', got {intent!r}")
    lots = int(lots)
    if lots < 1:
        raise ValueError(f"lots must be >= 1, got {lots}")
    sym = str(symbol).upper()
    if intent == "entry" and sym not in ROOTS:
        raise ValueError(f"an entry takes TXF/MXF/TMF (the lib picks the month), got {symbol!r}")
    if client_tag is not None and not _TAG_RE.match(str(client_tag)):
        raise ValueError(f"client_tag must be 1-10 alphanumeric chars, got {client_tag!r}")

    fields = {"venue": "president", "market": "futures", "symbol": sym, "action": action,
              "qty": lots, "unit": "lots", "intent": intent}
    guard.check_restart_stop(intent, fields)  # before the login
    _check_halt(fields)
    if intent == "reduce":
        fields["symbol"] = _checked_close(sym, action, lots)
    if client_tag is not None:
        fields["client_tag"] = client_tag

    from unitrade.unitrade import DOrderObject

    reports = _Reports()
    with _tag_guard(client_tag) as record_tag, _session(env) as api:
        if intent == "entry":
            fields["symbol"] = near_month(sym, _listed(api, sym))
        accounts = api.get_accounts() or []
        if not accounts:
            raise PresidentError("統一 login returned no futures account")
        o = DOrderObject()
        o.actno = accounts[0]
        o.subactno = ""
        o.productid = fields["symbol"]
        o.bs = "B" if action == "buy" else "S"
        o.ordertype = "M"
        o.price = 0
        o.orderqty = lots
        o.ordercondition = "I"
        o.opencloseflag = "1" if intent == "reduce" else ""
        o.dtrade = "N"
        o.note = client_tag or "blave"
        seq = _send(api, o, reports, fields)
        record_tag()
        result = _await(reports, seq, lots, confirm_timeout, fields)
    if result["status"] == "filled":
        guard.audit("order_filled", seq=seq, fill_qty=result["fill_qty"],
                    avg_fill_price=result["avg_fill_price"], **fields)
        _request_snapshot_refresh()
    logging.info(f"president {action} {fields['symbol']} {lots} lots → {result['status']} "
                 f"filled={result['fill_qty']} avg={result['avg_fill_price']:.2f} ack={result['ack']}")
    return result


# ── generic close-all support (manager/flatten.py) ───────────────────────────

def format_qty(env: dict, symbol: str, qty: float, price: float = None) -> str:
    """Lots are whole numbers; below 1 lot raises ValueError (flatten's dust-skip signal)."""
    lots = float(qty)
    if lots < 1:
        raise ValueError(f"president: {qty} lots is below the 1-lot minimum")
    return str(int(round(lots)))


def close_position_partial(env: dict, symbol: str, direction: str, qty: float,
                           client_order_id: str = None):
    """Reduce-only close of `qty` lots of the position held in `symbol` (TXF /
    MXF / TMF, or its month code). `direction` is the position being closed."""
    lots = int(round(float(qty)))
    if lots < 1:
        raise ValueError(f"president: {qty} lots is below the 1-lot minimum")
    action = "sell" if direction == "long" else "buy"
    result = place_futures_market_order(
        env, symbol, action, lots, intent="reduce",
        client_tag=_tag_for(client_order_id) if client_order_id else None)
    return {
        "avg_price": result.get("avg_fill_price") or 0.0,
        "executed_qty": result.get("fill_qty") or 0.0,
        "exchange": "president",
        "resolved_symbol": result.get("symbol"),
        "status": result.get("status"),
    }


# ── not verified — deliberately unimplemented ────────────────────────────────

_NOT_VERIFIED = ("not verified on 統一期貨 — no live account yet (the test host never fills); "
                 "implement from a user-approved live test, not from the docs alone.")


def cancel_order(*_args, **_kwargs):
    """刪單 (replace_order with replacetype 4)."""
    raise NotImplementedError(f"cancel_order is {_NOT_VERIFIED}")


def modify_order(*_args, **_kwargs):
    """改價/改量 (replace_order with replacetype m / 5)."""
    raise NotImplementedError(f"modify_order is {_NOT_VERIFIED}")


def place_stop_order(*_args, **_kwargs):
    """停損 — Unitrade has no stop / touch order type (L/M/P only)."""
    raise NotImplementedError("統一期貨 has no native stop order (order types L/M/P only) — "
                              "references/president-broker.md")
