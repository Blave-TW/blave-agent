# Account library for President Futures (統一期貨) — domestic futures account.
#
# Never talks to the broker: lib/president_worker.py holds the machine's one
# long-lived Unitrade login and writes state/president_account.json; this
# module reads that snapshot, so the platform readers never log in (and never
# hold the trading or certificate password).
#
# No get_flows: Unitrade has no deposit/withdrawal query (API/daccount lists
# margin, positions, unliquidated, combine, net — nothing else), so the
# platform falls back to flagging equity jumps as 資金異動, as it does for 群益.
# See references/president-broker.md.
import json
import logging
import os
import time

try:
    from lib import president_contracts as _contracts
except ImportError:  # loaded with lib/ itself on sys.path
    import president_contracts as _contracts
try:
    from lib import venue_errors
except ImportError:
    venue_errors = None

_SNAPSHOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "state", "president_account.json")
_STALE_S = 300  # worker cadence is 60 s; 5 misses = stale
_manual_logged = set()  # (productid, net) already logged by this process
ROOTS = ("TXF", "MXF", "TMF")


def _read_snapshot():
    try:
        with open(_SNAPSHOT, encoding="utf-8") as f:
            snap = json.load(f)
    except FileNotFoundError:
        raise RuntimeError("president snapshot missing — is the 統一期貨 worker "
                           "(lib/president_worker.py) running?")
    age = time.time() - snap.get("read_at", 0)
    if age > _STALE_S:
        raise RuntimeError(f"president snapshot stale ({int(age)}s old) — 統一期貨 worker down?")
    if not snap.get("ok"):
        raise RuntimeError(f"president worker error: {snap.get('error')}")
    return snap


def get_equity(env: dict) -> dict:
    """權益數 (get_margin optequity), TWD — matched the broker's app on the live
    account (10-02). Also: available (ordcexcess 可動用), initial_margin (iamt
    原始), maintenance_margin (mamt 維持). A 查無資料 answer is an error here,
    never a 0 equity."""
    snap = _read_snapshot()
    if snap.get("equity") is None:
        raise RuntimeError(f"president: no margin data ({snap.get('margin_error') or 'empty'}) — "
                           f"equity unknown")
    out = {"equity": snap["equity"], "currency": "TWD", "accounts": {"futures": snap["equity"]}}
    for k in ("available", "initial_margin", "maintenance_margin"):
        if snap.get(k) is not None:
            out[k] = snap[k]
    return out


def position_rows():
    """Futures rows as the worker read them, one per contract month:
    [{'root', 'productid', 'net'(signed lots), ...}] — lib/order_president
    closes by a row's own productid.

    Net = current_buy_open_position − current_sell_open_position (matched the
    broker's app on the live account, 10-02; ot_qty did not)."""
    return list(_read_snapshot().get("positions", []))


def bot_position_rows(now=None, book_months=None):
    """The held rows the bot trades on (lib/president_contracts.bot_rows) —
    what the reconciler reads, what flatten reads and what the order lib
    checks a close against. Settled residue of an expired month is dropped
    (logged, never closed — it was cash-settled); a month the bot does not
    trade (the user's own, opened in the app) is left out (logged once per
    position), so it neither blocks the bot's rows nor gets closed by them.
    book_months: the bot's book months per root (see bot_rows) — without it
    the calendar decides which months are the bot's."""
    return split_position_rows(now, book_months)[0]


def split_position_rows(now=None, book_months=None):
    """(keep, residue, manual) — bot_position_rows plus what it left out."""
    snap = _read_snapshot()
    keep, residue, manual = _contracts.bot_rows(snap.get("positions", []), snap.get("listed"), now,
                                                book_months)
    for r in residue:
        logging.info(f"[president] {r['productid']} {r['net']:+d}: past its settlement and not "
                     f"listed — treated as settled, ignored")
    for r in manual:
        if (r["productid"], r["net"]) not in _manual_logged:
            _manual_logged.add((r["productid"], r["net"]))
            logging.warning(f"[president] {r['productid']} {r['net']:+d}: a month the bot does not "
                            f"trade (opened in the app) — left out, Blave never touches it")
    return keep, residue, manual


def contract_month(code):
    """'YYYY-MM' of a 統一 month contract code (TXFJ6), None for anything else —
    lib.portfolio's book records the month a fill landed in with it."""
    try:
        return _contracts.ym(*_contracts.month_of(code))
    except (ValueError, TypeError):
        return None


def listed_months(root):
    """{'YYYY-MM', …} of `root`'s contracts the broker lists now, or None when
    the worker could not read the list — lib.portfolio tells a cash-settled
    month from a holiday-postponed one with it."""
    listed = (_read_snapshot().get("listed") or {}).get(str(root).upper())
    if not listed:
        return None
    return {m for m in (contract_month(c) for c in listed) if m}


def classify(exc):
    """lib.venue_errors class of a failed read: an unread contract list past a
    settlement is TRANSIENT (skip the round, never halt); anything else falls
    to the reconciler's floor."""
    if venue_errors is not None and isinstance(exc, _contracts.ListUnknown):
        return venue_errors.TRANSIENT
    return None


def get_positions(env: dict, book_months=None) -> dict:
    """{canonical: {'side', 'size', 'productid'}} with size in LOTS, canonical
    = TXF/MXF/TMF, from bot_position_rows(book_months=…). One root open in two
    contract months fails the read: summed, a long J6 and a short K6 would read
    as flat and the reconciler would trade on top of both; lib/order_president
    adds to a held month, so the bot's own orders do not get here."""
    months = {}
    for r in bot_position_rows(book_months=book_months):
        months.setdefault(r["root"], []).append(r)
    out = {}
    for root, rows in months.items():
        if len(rows) > 1:
            held = ", ".join(f"{r['productid']} {r['net']:+d}" for r in rows)
            raise RuntimeError(f"president: {root} is open in several contract months ({held}) — "
                               f"trading paused rather than add months together. It clears when the "
                               f"expiring month settles; if it does not, contact support")
        n = rows[0]["net"]
        out[root] = {"side": "long" if n > 0 else "short", "size": float(abs(n)),
                     "productid": rows[0]["productid"]}
    return out


def get_account_id(env: dict) -> str:
    """A fingerprint of the account the worker is logged in to (the account
    number itself is never written to the snapshot) — lets the book notice a
    rebind to another account. Raises when absent, never a silent None."""
    fp = _read_snapshot().get("account_fp")
    if not fp:
        raise RuntimeError("president snapshot has no account fingerprint — worker too old?")
    return f"president:{fp}"


def get_query_started_at() -> float:
    """When the worker's last read of the broker STARTED — what a send is
    compared with (a read begun before a send cannot show it). Maintenance
    re-stamps keep the original read's value."""
    q = _read_snapshot().get("query_started_at")
    if not q:
        raise RuntimeError("president snapshot has no query time — the 統一 worker is older "
                           "than this lib; restart it")
    return float(q)


def get_snapshot_read_at() -> float:
    """Unix seconds of the worker's last snapshot write (same freshness/ok
    checks as get_positions)."""
    return _read_snapshot()["read_at"]


def get_holdings(env: dict) -> list:
    """A futures margin account holds no coins or shares — always []."""
    _read_snapshot()
    return []
