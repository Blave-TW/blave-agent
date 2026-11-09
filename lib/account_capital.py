# Account library for Capital (群益) — securities + futures, Windows only.
#
# UNLIKE every other account lib, this one never talks to the venue: SKCOM
# (COM) only works under a password-logon Windows identity, and the platform
# account_reader runs as LocalSystem — a direct call would fail with cert
# error 602. lib/capital_worker.py (NSSM service `blave-agent-capital`,
# runs as Administrator) polls the venue and writes
# state/capital_account.json; this module just reads that snapshot.
# See references/capital-broker.md for the 602 background and field tables.
import json
import os
import re
import time
try:
    if __package__ == "lib":  # never a same-named file elsewhere on sys.path
        from lib.winreplace import load_json
    else:  # run as a script: lib/ is sys.path[0]
        from winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)
try:
    from lib import venue_errors
except ImportError:
    venue_errors = None

_SNAPSHOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "state", "capital_account.json")
_STALE_S = 300  # worker cadence is 60s; 5 misses = stale
# lib/order_capital.CAPITAL_FUT_RE — not imported: importing an order lib marks
# the process as a money process, and platform readers import this module
_FUT_RE = re.compile(r"^(MTX|TX|TM)(\d{2})(0[1-9]|1[0-2])$")


def contract_month(code):
    """'YYYY-MM' of a 群益 month contract code (TX2610), None for anything else —
    lib.portfolio's book records the month a fill landed in with it. 群益 has no
    contract list here, so a held row past its settlement is read as still
    trading (postponed) and an absent one as settled (lib.portfolio)."""
    m = _FUT_RE.match(str(code or "").strip().upper())
    return f"20{m.group(2)}-{m.group(3)}" if m else None


def _read_snapshot():
    try:
        snap = load_json(_SNAPSHOT)
    except FileNotFoundError:
        raise RuntimeError(
            "capital snapshot missing — is the blave-agent-capital service running?")
    age = time.time() - snap.get("read_at", 0)
    if age > _STALE_S:
        raise RuntimeError(
            f"capital snapshot stale ({int(age)}s old) — blave-agent-capital service down?")
    if not snap.get("ok"):
        e = RuntimeError(f"capital worker error: {snap.get('error')}")
        e.code = snap.get("code")
        raise e
    return snap


# SKCOM manual V2.13.59 codes for a lost link (lib/order_capital.SESSION_LOST_CODES), plus the
# worker's own marker for a query whose reply never came (capital_worker.QUERY_TIMEOUT)
_TRANSIENT_CODES = frozenset({"1000", "1041", "1108", "1109", "timeout"})


def classify(exc):
    """lib.venue_errors class of a failed read: the worker lost its link to 群益 or a query's
    reply never came → TRANSIENT (skip the round, never halt — the worker logs in again by
    itself); anything else falls to the reconciler's floor (UNKNOWN: three in a row HALT).
    300/307 never get here: the reconciler skips those rounds first (_capital_login_stopped)."""
    if venue_errors is not None and str(getattr(exc, "code", None)) in _TRANSIENT_CODES:
        return venue_errors.TRANSIENT
    return None


def get_equity(env: dict) -> dict:
    snap = _read_snapshot()
    if snap.get("equity") is None:
        # Securities-only Capital account: no TF futures account, and
        # securities inventory valuation isn't implemented yet — a readable
        # error beats a silent 0 pretending to be equity.
        raise RuntimeError(
            "capital: no futures account on this ID — equity for "
            "securities-only accounts is not supported yet (holdings still "
            "listed; valuation pending)")
    out = {"equity": snap["equity"], "currency": snap.get("currency", "TWD")}
    if isinstance(snap.get("accounts"), dict):
        out["accounts"] = snap["accounts"]
    # Margin rows on the assets page. Only `available` (GetFutureRights idx 31)
    # ships — the worker never reads initial / maintenance margin: the rights
    # row has idx 13/14 and 15/16 and 21 (references/capital-broker.md), and
    # which pair matches the broker's app is unverified. TODO: verify against
    # the app the way 統一 was (10-02), then read them in capital_worker and
    # pass initial_margin / maintenance_margin here.
    if snap.get("available") is not None:
        out["available"] = snap["available"]
    return out


def get_positions(env: dict) -> dict:
    """{symbol: {'side', 'size', 'entry_price', 'unrealized_pnl', 'margin',
    'leverage'}} — size in LOTS, not account currency:
    TWD notional needs a mark price the worker doesn't fetch. TW futures
    never enter the auto-wired reconciler (hand-wired per venue-onboarding),
    so lots-for-display is the honest value.

    'side' is 'long'/'short' (account_TEMPLATE.py's contract — every other
    venue's account lib uses this, and manager/flatten.py's close-all rejects
    anything else: 'bad position row (side=buy)', live-verified 2026-08-14,
    silently skipped the position instead of closing it). The worker's raw
    snapshot uses the exchange's own 'buy'/'sell' wording — normalize here,
    once, at the contract boundary.

    GetOpenInterest reports buy and sell as separate rows — net them per
    symbol or a hedged/day-trade book shows only whichever row came last.

    entry_price is the lot-weighted avg_cost (GetOpenInterest field 6) of the
    symbol's rows, only when they are all on one side and all carry a cost: a
    buy row and a sell row each have their own cost and neither is the cost
    of the net. unrealized_pnl, margin, leverage are None — GetOpenInterest
    has no PnL (the worker has no quote feed), margin is account-level only
    (get_equity), and TW futures have no leverage setting."""
    snap = _read_snapshot()
    net, sides, cost = {}, {}, {}
    for p in snap.get("positions", []):
        lots = p.get("lots", 0.0) or 0.0
        if lots <= 0:
            continue
        sym = p["symbol"]
        net[sym] = net.get(sym, 0.0) + (lots if p.get("side") == "buy" else -lots)
        sides.setdefault(sym, set()).add(p.get("side"))
        avg = p.get("avg_cost")
        if sym in cost and cost[sym] is None:
            continue
        if isinstance(avg, (int, float)) and avg > 0 and lots > 0:
            paid, held = cost.get(sym, (0.0, 0.0))
            cost[sym] = (paid + avg * lots, held + lots)
        else:
            cost[sym] = None
    out = {}
    for sym, n in net.items():
        if n == 0:
            continue
        c = cost.get(sym)
        out[sym] = {"side": "long" if n > 0 else "short", "size": abs(n),
                    "entry_price": c[0] / c[1] if c and len(sides[sym]) == 1 else None,
                    "unrealized_pnl": None, "margin": None, "leverage": None}
    return out


def get_snapshot_read_at() -> float:
    """Unix seconds of the worker's most recent successful snapshot write.
    Used by manager/reconciler.py's Read-Your-Writes guard to detect a
    just-placed order the snapshot hasn't caught up to yet (worker cadence is
    60s). Reuses _read_snapshot()'s freshness/ok checks — a genuinely
    stale/dead worker raises the same RuntimeError get_positions() would."""
    return _read_snapshot()["read_at"]


def get_query_started_at() -> float:
    """When the worker's last successful read of the broker STARTED — what
    the reconciler compares with its last order. A snapshot from a worker
    older than this field falls back to read_at: nothing restarts the
    blave-agent-capital service on a workspace update, and refusing those
    snapshots would pause every running 群益 machine until someone does."""
    snap = _read_snapshot()
    q = snap.get("query_started_at")
    return float(q if q else snap["read_at"])


def get_holdings(env: dict) -> list:
    """Securities inventory as display-only holdings (wallet='securities');
    usdt_value None — no on-machine price source, platform lists them unpriced
    rather than hiding them."""
    return _read_snapshot().get("holdings", [])
