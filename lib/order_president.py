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
   the backtest's TXFR1 series changes contract). New positions roll at the
   night session before it: from 15:00 the day before settlement entries go to
   the next month (entry_roll_at — why: see there). The computed contract must
   appear in the broker's get_domestic_contracts list, else the order is
   refused. A reduce/close goes to the productid of the position row it closes
   (lib/account_president's snapshot) with opencloseflag "1" (close only), and
   only after the snapshot confirms the side and the size: a reduce that would
   add to or reverse a position, or a snapshot whose read started less than
   ORDER_SETTLE_S after this contract's last send, is refused before the login
   (_claim: check + send marker under one machine-wide lock; the marker is
   written again right before the send, so a slow login does not eat the
   margin). An entry goes to the month already held for that root (never two
   months at once — covers the settlement window and holiday-postponed
   settlements), else the computed near month, and waits (EntryDeferred) while
   the snapshot has not caught up.
   NOT verified across a real settlement day.
2. SENT ≠ ACCEPTED ≠ FILLED. order() returning issend=True only means the
   request left this machine. Accepted = an on_reply for OUR seq with
   a success status code (0000/0001/0003/0004/0006 — live market orders
   answer 0004 directly). A fill = on_match rows for
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
president_ca_path / president_ca_password (+ president_url for production,
switched on only by the binding flow's vault) — resolved by lib/president_vault.py.
"""

import json
import logging
import os
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from hashlib import sha1

from lib import guard, president_vault
from lib.president_contracts import (MONTH_CODES, PROD_RE, ROOTS, TAIPEI, ManualPosition,  # noqa: F401
                                     computed_near, entry_roll_at, front_month, prod_id,
                                     settlement_at)

guard.mark_money_process()  # Stop in the chat never kills this process (lib/guard)

_WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# lib/president_worker.py early-ticks on this (same path derivation there)
_REFRESH_FLAG = os.path.join(_WS, "state", "president_refresh")
_TAGS_PATH = os.path.join(_WS, "state", "president_order_tags.json")
# {productid: unix time of the last send} — read by the reduce check here and by
# manager/reconciler.py's Read-Your-Writes guard
LAST_ORDER_PATH = os.path.join(_WS, "state", "president_last_order_at.json")
SEND_LOCK_PATH = os.path.join(_WS, "state", "president_send.lock")
SDK_LOG_DIR = os.path.join(_WS, "state", "president_logs")

_TAG_RE = re.compile(r"^[A-Za-z0-9]{1,10}$")
# Reply status codes, from unitrade 1.0.0.7 trade/dlogic (DLogic.*_CODE):
# 0000 委託成功, 0001 減量成功, 0002 刪單成功, 0003 部份成交, 0004 完全成交,
# 0006 改價成功; 9999 = an error reply (parse_error), ERR1/2/3/5 = 委託傳送失敗 /
# 尚未開盤 / 驗章失敗 / 已收盤. The official dtrade page shows a server reply
# 9902 "TTO0002:尚未開始接收委託或者不接受此種委託" — 99xx are rejections. The live account's first reply to a market IOC was
# already 0004 (10-02); the test host answers 0000 and never fills.
_ACCEPTED = {"0000", "0001", "0003", "0004", "0006"}
_CANCELED = {"0002"}  # 0001 (a reduction) is not terminal

_tags_lock = threading.Lock()


try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt


@contextmanager
def _os_lock(path, timeout, what):
    """An exclusive OS lock on `path` (flock / msvcrt byte lock). The OS drops
    it when the holder exits or is killed, so there is no stale-file reclaim —
    and no reclaim race between two waiters (audit round 3 P2-1)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.time() + timeout
    try:
        while True:
            try:
                if fcntl:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.time() > deadline:
                    raise PresidentError(f"another 統一 order holds the {what} — retry")
                time.sleep(0.05)
        try:
            yield
        finally:
            try:
                if fcntl:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                else:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
    finally:
        os.close(fd)


class PresidentError(Exception):
    """The broker refused or could not take an order; message carries its code/text."""


class EntryDeferred(PresidentError):
    """An entry in the settlement window that waits for a fresh snapshot to pick
    its month — a scheduled wait, not a failure; nothing was sent."""


class DuplicateOrder(PresidentError):
    """This client_tag was already sent today — refused before reaching the broker."""


# ── near month (rule 1) ──────────────────────────────────────────────────────

def _require_listed(want, listed):
    listed = [str(x).upper() for x in (listed or [])]
    if want not in listed:
        raise PresidentError(f"contract {want} is not in the broker's contract list {listed} — "
                             f"not trading on a guess")
    return want


def near_month(root, listed, now=None):
    """The contract an entry goes to at `now` (tz-aware; default: now in
    Taipei). Raises if the computed contract is not in `listed` — the broker's
    own list is the check, never the fallback."""
    return _require_listed(computed_near(root, now), listed)


def entry_contract(root, rows, now=None):
    """The contract an entry for `root` goes to: the month already held for that
    root, if there is one; otherwise computed_near(). Adding where the position
    already is means the account never holds two months of a root (a read the
    reconciler refuses):
    - in the settlement window, a held expiring month is added to and settles
      with the rest at 13:30, instead of opening the next month beside it;
    - when a holiday postpones the settlement past the third Wednesday, the
      expiring month is still held and still listed after the computed roll —
      the calendar alone would open the next month beside it and pause trading
      for a day. The broker's contract list is the check (_require_listed): a
      held month the broker no longer lists is refused, never guessed around.
    A held month is only trusted from a snapshot read after the last send."""
    root = str(root).upper()
    # `rows` are the bot's rows (account_president.bot_position_rows): settled
    # residue is already gone, a manual month already failed the read
    held = sorted({r["productid"] for r in rows if r["root"] == root and r["net"]})
    if len(held) == 1:
        return held[0]
    if held:
        raise PresidentError(f"{root} is held in several months {held} — no entry until one settles")
    return computed_near(root, now)


def _entry_contract_checked(root):
    """entry_contract() on the worker snapshot, which must have been read after
    the last send settled — else a just-opened or just-closed month would be
    misread (EntryDeferred: the entry waits a round, nothing is sent)."""
    from lib.account_president import bot_position_rows
    ok, _q, _last = snapshot_caught_up()
    if not ok:
        raise EntryDeferred("the 統一 snapshot has not caught up with the last order — the entry "
                            "waits for it to pick its contract month")
    return entry_contract(root, bot_position_rows())


def _listed(api, root):
    resp = api.get_domestic_contracts(root, "F")
    if not resp or not resp.ok:
        err = president_vault.sanitize(getattr(resp, "error", "") or "no answer")
        raise PresidentError(f"get_domestic_contracts({root}) failed: {err}")
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


def snapshot_caught_up(productid=None):
    """(ok, query_started_at, last_send): the worker's last read STARTED at
    least ORDER_SETTLE_S after the last send (to `productid`, or to anything).
    The query start, not the write time: a read that began before the send and
    finished after it still shows the old position."""
    from lib.account_president import get_query_started_at
    q = get_query_started_at()
    last = last_order_at(productid)
    return (not last or q >= last + president_vault.ORDER_SETTLE_S), q, last


def _send_lock():
    """One machine-wide lock around "check the snapshot → write the send
    marker": two processes (the reconciler and a flatten, an agent script…)
    must not both pass the same snapshot check. Held for milliseconds — the
    marker is written before the login, so the second holder sees it and is
    refused by snapshot_caught_up until the worker has read past the send."""
    return _os_lock(SEND_LOCK_PATH, 30, "send lock")


def _claim(symbol, action, lots, intent):
    """Pick the contract and write its send marker under the machine-wide lock
    — every order path (reconciler, flatten, agent scripts) comes through here
    before logging in. Returns the productid."""
    with _send_lock():
        pid = (_checked_close(symbol, action, lots) if intent == "reduce"
               else _entry_contract_checked(symbol))
        _mark_order_sent(pid)
    _request_snapshot_refresh()  # the worker re-reads once the send has settled
    return pid


def _mark_order_sent(productid):
    """Raises when the marker cannot be written: an order the guards cannot see
    is an order that may be sent twice, so nothing is sent without it."""
    d = _last_orders()
    d[productid] = time.time()
    try:
        os.makedirs(os.path.dirname(LAST_ORDER_PATH), exist_ok=True)
        with open(LAST_ORDER_PATH + ".tmp", "w", encoding="utf-8") as f:
            json.dump(d, f)
        os.replace(LAST_ORDER_PATH + ".tmp", LAST_ORDER_PATH)
    except OSError as e:
        raise PresidentError(f"the send marker could not be written ({type(e).__name__}) — "
                             f"not sending")


def _checked_close(symbol, action, lots):
    """The productid a close of `lots` by `action` goes to — only when the
    snapshot shows a position on the other side, at least that large, read
    after this contract's last order settled. Anything else is refused (never
    sent). Call under _send_lock()."""
    from lib.account_president import bot_position_rows
    sym = str(symbol).upper()
    if not PROD_RE.match(sym) and sym not in ROOTS:
        raise ValueError(f"{symbol!r} is not TXF/MXF/TMF or a month contract code")
    rows = bot_position_rows()  # never a settled month (cash-settled) or a manual one
    hits = [r for r in rows if (r["productid"] == sym if PROD_RE.match(sym) else r["root"] == sym)]
    if not hits:
        raise PresidentError(f"no open {sym} position in the 統一 snapshot — nothing to close")
    if len(hits) > 1:
        raise PresidentError(f"{sym} is open in several months {sorted(r['productid'] for r in hits)} "
                             f"— close each by its contract code, not the root")
    row = hits[0]
    ok, _q, _last = snapshot_caught_up(row["productid"])
    if not ok:
        raise PresidentError(f"the 統一 snapshot was read before the last {row['productid']} order "
                             f"settled — not closing on positions that may already have changed; "
                             f"retry shortly")
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
    with _os_lock(_TAGS_PATH + ".lock", 30, "client_tag book"):
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


def _tag_for(client_order_id):
    """A ≤10-char note from a caller's id: itself if it fits, else a digest."""
    cid = str(client_order_id)
    return cid if _TAG_RE.match(cid) else "c" + sha1(cid.encode()).hexdigest()[:9]


# ── session + send + confirm ─────────────────────────────────────────────────

@contextmanager
def _session(env):
    # credentials and the host come from the workspace .env and vault, never from `env`
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
    # again, right before the send: the marker taken before the login holds the
    # place against a concurrent close, but a slow login (up to LOGIN_TIMEOUT_S)
    # would eat the settle margin if the guard counted from it
    with _send_lock():
        _mark_order_sent(obj.productid)
    resp = api.dtrade.order(obj)
    if not resp.issend:
        _request_snapshot_refresh()  # nothing went out: let the worker clear the marker's hold
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
    unknown = False
    if ack and code not in _ACCEPTED and code not in _CANCELED:
        err = president_vault.sanitize(ack.get("orderstatus"))
        if str(code).startswith(("99", "ERR")):
            guard.audit("order_error", seq=seq, code=code, error=err, **fields)
            raise PresidentError(f"統一 rejected the order: statuscode={code} {err}")
        # a code the SDK does not define: not a success, not a rejection — fills
        # still count if match rows arrive; otherwise 'unknown', never resent
        unknown = True
        guard.audit("order_unknown_status", seq=seq, code=code, error=err, **fields)
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
    return {"seq": seq, "orderno": orderno,
            "status": "filled" if qty else ("unknown" if unknown else "sent"),
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
    if client_tag is not None:
        fields["client_tag"] = client_tag

    from unitrade.unitrade import DOrderObject

    reports = _Reports()
    with _tag_guard(client_tag) as record_tag:
        fields["symbol"] = _claim(sym, action, lots, intent)
        with _session(env) as api:
            if intent == "entry":
                _require_listed(fields["symbol"], _listed(api, sym))
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
    # the broker's own codes travel with the close as with an entry (the 10-02
    # live close came back without them: this mapping dropped them)
    return {
        "avg_price": result.get("avg_fill_price") or 0.0,
        "executed_qty": result.get("fill_qty") or 0.0,
        "exchange": "president",
        "resolved_symbol": result.get("symbol"),
        "status": result.get("status"),
        "ack": result.get("ack"),
        "statuscode": result.get("statuscode"),
        "seq": result.get("seq"),
        "orderno": result.get("orderno"),
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
