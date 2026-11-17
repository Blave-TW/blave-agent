# SinoPac (永豐期貨) domestic futures account reads.
#
# NOT live-verified (tests/check_sinopac_futures.py fakes the SDK): every read
# raises until lib/venue_traits' sinopac row lists "futures" in verified_modes.
# Deliberately not named lib/account_sinopac.py: runtime/account_reader and
# manager/flatten pick up any lib/account_<venue>.py. Becoming the venue's
# account lib is part of the futures verification commit; even then a machine
# with only the odd-lot era's sinopac_* keys is not read (venue_traits
# bound_marker: the worker never started there, no read). Never talks
# to the broker: lib/sinopac_worker.py holds the machine's one Shioaji login and
# writes state/sinopac_account.json; this module only reads that snapshot, so a
# platform reader never opens a second connection against the person's 5.
#
# No get_flows, as lib/account_capital: the 1.7.11 stub has no deposit /
# withdrawal history query (margin() carries only the day's deposit_withdrawal
# total), so the platform flags an equity jump as 資金異動 the way it does for
# 群益 and 統一 (references/sinopac-broker.md › Account reads).
import logging
import os
import time

#
# The broker's position read lags a fill: M0-b (2026-11-16) read [] right after a Filled
# order. Position reads refuse (SnapshotLag, TRANSIENT) a snapshot whose read started less
# than lib/sinopac_vault.ORDER_SETTLE_S after this machine's last send, so that [] is never
# taken as flat; a fill is booked from the order response's fill_qty, not from here.
try:
    from lib import president_contracts as _contracts  # the TAIFEX calendar, not a 統一 rule
    from lib import sinopac_vault as _vault
    from lib import venue_traits as _traits
    from lib.winreplace import load_json
except ImportError:  # loaded with lib/ itself on sys.path
    import president_contracts as _contracts
    import sinopac_vault as _vault
    import venue_traits as _traits
    from winreplace import load_json
try:
    from lib import venue_errors
except ImportError:
    venue_errors = None

_SNAPSHOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "state", "sinopac_account.json")
_STALE_S = 300  # worker cadence is 60 s; 5 misses = stale
ROOTS = _contracts.ROOTS
VERIFIED = "futures" in _traits.verified_modes("sinopac")
_manual_logged = set()  # (productid, net) already logged by this process


def _read_snapshot():
    if not VERIFIED:
        raise RuntimeError("永豐期貨帳戶讀取還沒通過真帳驗證 — not read")
    try:
        snap = load_json(_SNAPSHOT, encoding="utf-8")
    except FileNotFoundError:
        raise RuntimeError("sinopac snapshot missing — is the 永豐 futures worker "
                           "(lib/sinopac_worker.py) running?")
    age = time.time() - snap.get("read_at", 0)
    if age > _STALE_S:
        raise RuntimeError(f"sinopac snapshot stale ({int(age)}s old) — 永豐 worker down?")
    if not snap.get("ok"):
        raise RuntimeError(f"sinopac worker error: {snap.get('error')}")
    return snap


def waiting():
    """'login_retry' while the worker waits to retry a login that never got an answer (its snapshot
    fresh), else None — as lib/account_president.waiting: not a failed read, the reconciler skips
    the round. Reads nothing while futures are unverified."""
    if not VERIFIED:
        return None
    try:
        snap = load_json(_SNAPSHOT, encoding="utf-8")
    except (OSError, ValueError):
        return None
    if not isinstance(snap, dict) or snap.get("ok") or not snap.get("waiting"):
        return None
    if time.time() - float(snap.get("read_at") or 0) > _STALE_S:
        return None
    return str(snap["waiting"])


class SnapshotLag(RuntimeError):
    """The worker's last read began before this machine's last send had settled — its positions
    may not show that send yet (not a connectivity failure: skip the round)."""


def snapshot_caught_up(snap=None):
    """(ok, query_started_at, last_send): the read STARTED at least ORDER_SETTLE_S after the last
    send — the query start, not the write time (a read begun before the send and finished after
    it still shows the old position). `snap`: judge that snapshot, not a fresh read of the file."""
    q = float(snap.get("query_started_at") or 0) if snap is not None else get_query_started_at()
    last = _vault.last_order_at()
    return (not last or q >= last + _vault.ORDER_SETTLE_S), q, last


def _settled_snapshot():
    snap = _read_snapshot()
    ok, q, last = snapshot_caught_up(snap)  # the same read: the worker may replace the file meanwhile
    if not ok:
        raise SnapshotLag(f"永豐部位快取尚未跟上最近一次下單(查詢開始於 {q:.0f},下單於 {last:.0f},需晚 "
                          f"{_vault.ORDER_SETTLE_S} 秒)/ the 永豐 position read started before the last "
                          f"send settled — skipped this round")
    return snap


def get_equity(env: dict) -> dict:
    """權益數 (margin().equity), TWD; plus available / initial_margin /
    maintenance_margin. Which Margin field matches the app is unverified."""
    snap = _read_snapshot()
    out = {"equity": snap["equity"], "currency": "TWD", "accounts": {"futures": snap["equity"]}}
    for k in ("available", "initial_margin", "maintenance_margin"):
        if snap.get(k) is not None:
            out[k] = snap[k]
    return out


def position_rows():
    """[{'root', 'productid', 'net' (signed lots), 'avg_cost', 'floating_pnl'}], one per month,
    as the worker read them. Raises SnapshotLag inside a send's settle window."""
    return list(_settled_snapshot().get("positions", []))


def split_position_rows(now=None, book_months=None):
    """(keep, residue, manual), as lib/account_president: the rows the bot counts, the settled
    residue of an expired month (ignored, never closed), the months the bot does not trade
    (the user's own, left out). book_months: the bot's book months per root
    (president_contracts.bot_rows); None = the calendar decides. Raises SnapshotLag inside a
    send's settle window."""
    snap = _settled_snapshot()
    keep, residue, manual = _contracts.bot_rows(snap.get("positions", []), snap.get("listed"), now,
                                                book_months, broker="永豐")
    for r in residue:
        logging.info(f"[sinopac] {r['productid']} {r['net']:+d}: past its settlement and not "
                     f"listed — treated as settled, ignored")
    for r in manual:
        if (r["productid"], r["net"]) not in _manual_logged:
            _manual_logged.add((r["productid"], r["net"]))
            logging.warning(f"[sinopac] {r['productid']} {r['net']:+d}: a month the bot does not "
                            f"trade (opened in the app) — left out, Blave never touches it")
    return keep, residue, manual


def bot_position_rows(now=None, book_months=None):
    return split_position_rows(now, book_months)[0]


def get_positions(env: dict, book_months=None) -> dict:
    """{TXF|MXF|TMF: {'side', 'size' (LOTS), 'productid', 'entry_price',
    'unrealized_pnl', 'margin', 'leverage'}} from bot_position_rows(book_months=…).
    A root open in two months fails the read — summed, a long and a short
    month would read as flat."""
    by_root = {}
    for r in bot_position_rows(book_months=book_months):
        by_root.setdefault(r["root"], []).append(r)
    out = {}
    for root, rows in by_root.items():
        if len(rows) > 1:
            held = ", ".join(f"{r['productid']} {r['net']:+d}" for r in rows)
            raise RuntimeError(f"sinopac: {root} is open in several contract months ({held}) — "
                               f"trading paused rather than add months together")
        n = rows[0]["net"]
        avg = rows[0].get("avg_cost")
        out[root] = {"side": "long" if n > 0 else "short", "size": float(abs(n)),
                     "productid": rows[0]["productid"],
                     "entry_price": avg if isinstance(avg, (int, float)) and avg > 0 else None,
                     "unrealized_pnl": None, "margin": None, "leverage": None}
    return out


def listed_months(root):
    """{'YYYY-MM', …} of `root`'s contracts the broker lists now, or None when the worker could
    not read the list — lib.portfolio tells a cash-settled month from a postponed one with it."""
    listed = (_read_snapshot().get("listed") or {}).get(str(root).upper())
    if not listed:
        return None
    return {m for m in (contract_month(c) for c in listed) if m}


def classify(exc):
    """An unread contract list past a settlement, or a snapshot inside a send's settle window, is
    TRANSIENT (skip the round, never halt); anything else falls to the reconciler's floor."""
    if venue_errors is not None and isinstance(exc, (_contracts.ListUnknown, SnapshotLag)):
        return venue_errors.TRANSIENT
    return None


def contract_month(code):
    """'YYYY-MM' of a month contract code (TXFK6), None for anything else."""
    try:
        return _contracts.ym(*_contracts.month_of(code))
    except (ValueError, TypeError):
        return None


def get_account_id(env: dict) -> str:
    fp = _read_snapshot().get("account_fp")
    if not fp:
        raise RuntimeError("sinopac snapshot has no account fingerprint — worker too old?")
    return f"sinopac:{fp}"


def get_query_started_at() -> float:
    """When the worker's last read of the broker STARTED — what a send is compared with (a read
    begun before a send cannot show it)."""
    q = _read_snapshot().get("query_started_at")
    if not q:
        raise RuntimeError("sinopac snapshot has no query time — the 永豐 worker is older than "
                           "this lib; restart it")
    return float(q)


def get_snapshot_read_at() -> float:
    return _read_snapshot()["read_at"]


def get_holdings(env: dict) -> list:
    """A futures margin account holds no coins or shares — always []."""
    _read_snapshot()
    return []
