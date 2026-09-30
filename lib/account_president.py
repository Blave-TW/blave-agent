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
import os
import time

_SNAPSHOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "state", "president_account.json")
_STALE_S = 300  # worker cadence is 60 s; 5 misses = stale
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
    """權益數 (get_margin optequity), TWD. The margin query answers 查無資料 on
    an unfunded test account — that is an error here, never a 0 equity."""
    snap = _read_snapshot()
    if snap.get("equity") is None:
        raise RuntimeError(f"president: no margin data ({snap.get('margin_error') or 'empty'}) — "
                           f"equity unknown")
    out = {"equity": snap["equity"], "currency": "TWD", "accounts": {"futures": snap["equity"]}}
    for k in ("available", "initial_margin"):  # mamt 可用保證金 / iamt 原始保證金
        if snap.get(k) is not None:
            out[k] = snap[k]
    return out


def position_rows():
    """Futures rows as the worker read them, one per contract month:
    [{'root', 'productid', 'net'(signed lots), ...}] — lib/order_president
    closes by a row's own productid.

    Net = ot_qty_b − ot_qty_s. Which of that and current_buy/sell_open_position
    is the live open interest is only verified on one preloaded test row where
    both said 1; when they disagree the read fails rather than guess."""
    rows = list(_read_snapshot().get("positions", []))
    for r in rows:
        if r.get("net_current") is not None and r["net_current"] != r["net"]:
            raise RuntimeError(f"president: {r['productid']} open interest disagrees "
                               f"(ot_qty {r['net']:+d} vs current_open {r['net_current']:+d}) — "
                               f"not reading a position I can't pin down")
    return rows


def get_positions(env: dict) -> dict:
    """{canonical: {'side', 'size'}} with size in LOTS, canonical = TXF/MXF/TMF.
    Several months of one root are netted; 'productid' is set only when a
    single month is open (a close must name that month — lib/order_president)."""
    net, months = {}, {}
    for r in position_rows():
        net[r["root"]] = net.get(r["root"], 0) + r["net"]
        months.setdefault(r["root"], []).append(r["productid"])
    out = {}
    for root, n in net.items():
        if n == 0:
            continue
        row = {"side": "long" if n > 0 else "short", "size": float(abs(n))}
        if len(months[root]) == 1:
            row["productid"] = months[root][0]
        out[root] = row
    return out


def get_account_id(env: dict) -> str:
    """A fingerprint of the account the worker is logged in to (the account
    number itself is never written to the snapshot) — lets the book notice a
    rebind to another account. Raises when absent, never a silent None."""
    fp = _read_snapshot().get("account_fp")
    if not fp:
        raise RuntimeError("president snapshot has no account fingerprint — worker too old?")
    return f"president:{fp}"


def get_snapshot_read_at() -> float:
    """Unix seconds of the worker's last snapshot write (same freshness/ok
    checks as get_positions)."""
    return _read_snapshot()["read_at"]


def get_holdings(env: dict) -> list:
    """A futures margin account holds no coins or shares — always []."""
    _read_snapshot()
    return []
