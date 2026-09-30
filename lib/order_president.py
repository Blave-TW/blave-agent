"""
President Futures (統一期貨) domestic futures orders — Unitrade API (`pip
install unitrade`). TXF / MXF / TMF market orders only. Companion reference:
references/president-broker.md (read it before any 統一 work).

Taiwan-broker shape, like lib/order_capital.py (NOT lib/order_TEMPLATE.py's
perp contract): quantities are 口 (lots), symbols are the canonical roots
TXF / MXF / TMF, the lib maps them to a month contract (TXFJ6 = TXF, J=Oct, 6=2026).

Design rules:
1. ENTRY → COMPUTED NEAR MONTH, CLOSE → THE ROW'S OWN CONTRACT. An entry goes
   to near_month(): the first contract whose settlement (third Wednesday of
   its month, 13:30 Taipei) is still ahead — the same instant the backtest's
   TXFR1 continuous series rolls. It must also appear in the broker's
   get_domestic_contracts list, else the order is refused. A reduce/close goes
   to the productid of the position row it closes (lib/account_president's
   snapshot), never a re-derived month: after a roll the near month is not the
   contract that is held. NOT verified across a real settlement day.
2. SENT ≠ ACCEPTED ≠ FILLED. order() returning issend=True only means the
   request left this machine. Accepted = an on_reply for OUR seq with
   statuscode '0000' (or a fill code 0003/0004). A fill = on_match rows for
   the orderno that reply carried (on_match has no seq). No fill seen within
   confirm_timeout returns status 'sent' with fill_qty 0 — an IOC the market
   did not take, or a fill not yet reported; the IOC-cancel report has never
   been observed (the test host never fills). Never resubmit on 'sent'.
3. NO CLIENT ORDER ID AT THE BROKER. `note` (≤10 chars) is only a label. A
   client_tag is refused locally if it was already sent today
   (state/president_order_tags.json, written BEFORE the send) — the same
   intent as order_sinopac's client_tag, kept on this machine because the
   broker cannot check it.
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
SDK_LOG_DIR = os.path.join(_WS, "state", "president_logs")

# fixed UTC+8 (no DST since 1979): Windows Python ships no tz database, ZoneInfo would raise there
TAIPEI = timezone(timedelta(hours=8), "Asia/Taipei")
ROOTS = ("TXF", "MXF", "TMF")
MONTH_CODES = "ABCDEFGHIJKL"  # futures month letters, A = January
SETTLE_HOUR, SETTLE_MINUTE = 13, 30
PROD_RE = re.compile(r"^(TXF|MXF|TMF)([A-L])(\d)$")
_TAG_RE = re.compile(r"^[A-Za-z0-9]{1,10}$")
_ACCEPTED = {"0000", "0003", "0004"}
_CANCELED = {"0001", "0002"}

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
    while settlement_at(y, m) <= now:
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


def _held_productid(symbol):
    """The productid of the open position a close for `symbol` must go to."""
    sym = str(symbol).upper()
    if PROD_RE.match(sym):
        return sym
    if sym not in ROOTS:
        raise ValueError(f"{symbol!r} is not TXF/MXF/TMF or a month contract code")
    from lib.account_president import position_rows
    months = sorted({r["productid"] for r in position_rows() if r["root"] == sym})
    if not months:
        raise PresidentError(f"no open {sym} position in the 統一 snapshot — nothing to close")
    if len(months) > 1:
        raise PresidentError(f"{sym} is open in several months {months} — close each by its "
                             f"contract code, not the root")
    return months[0]


# ── local duplicate guard (rule 3) ───────────────────────────────────────────

def _claim_tag(tag):
    today = datetime.now(TAIPEI).strftime("%Y-%m-%d")
    with _tags_lock:
        try:
            with open(_TAGS_PATH, encoding="utf-8") as f:
                book = json.load(f)
        except (OSError, ValueError):
            book = {}
        tags = book.get("tags", []) if book.get("date") == today else []
        if tag in tags:
            raise DuplicateOrder(f"client_tag {tag!r} was already sent today — refused (the broker "
                                 f"has no client order id to deduplicate on)")
        os.makedirs(os.path.dirname(_TAGS_PATH), exist_ok=True)
        tmp = _TAGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"date": today, "tags": tags + [tag]}, f)
        os.replace(tmp, _TAGS_PATH)


def _tag_for(client_order_id):
    """A ≤10-char note from a caller's id: itself if it fits, else a digest."""
    cid = str(client_order_id)
    return cid if _TAG_RE.match(cid) else "c" + sha1(cid.encode()).hexdigest()[:9]


# ── session + send + confirm ─────────────────────────────────────────────────

@contextmanager
def _session(env):
    api = president_vault.login(president_vault.resolve(env), SDK_LOG_DIR)
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
    resp = api.dtrade.order(obj)
    if not resp.issend:
        guard.audit("order_error", code=resp.errorcode, error=resp.errormsg, **fields)
        raise PresidentError(f"order not sent: {resp.errorcode} {resp.errormsg}")
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
        guard.audit("order_error", seq=seq, code=code, error=ack.get("orderstatus"), **fields)
        raise PresidentError(f"統一 rejected the order: statuscode={code} {ack.get('orderstatus')}")
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
    """One market IOC order, opencloseflag "" (broker decides open/close).

    symbol: TXF / MXF / TMF — an entry goes to the computed near month; a
    reduce goes to the held row's productid (a month code like TXFJ6 is also
    accepted for a reduce). action: 'buy'|'sell'. lots: int ≥ 1. intent:
    'entry'|'reduce', REQUIRED (the broker's auto flag cannot say which;
    'entry' is HALT-blocked). client_tag: ≤10 alphanumeric chars, refused if
    already sent today.

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
        fields["symbol"] = _held_productid(sym)
    if client_tag is not None:
        _claim_tag(client_tag)
        fields["client_tag"] = client_tag

    from unitrade.unitrade import DOrderObject

    reports = _Reports()
    with _session(env) as api:
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
        o.opencloseflag = ""
        o.dtrade = "N"
        o.note = client_tag or "blave"
        seq = _send(api, o, reports, fields)
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
