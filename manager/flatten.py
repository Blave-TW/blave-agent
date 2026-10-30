"""Flatten: market-close the BOT's positions on every connected venue.

The web 暫停並全部平倉 runs this (the command listener trips state/HALT first,
then launches this detached); it is also runnable by hand:

    cd workspace && python3 manager/flatten.py

Scope — what "the bot's positions" means (lib.portfolio.own_positions_only;
every machine since 2026-09-23 unless its config says "self_ledger": false):
  - own positions only: ONLY the bot's own ledger positions
    (lib.portfolio.ledger_positions) are closed — the user's manual positions
    on the same account are never touched, not even by this button. Matches
    the 3Commas/Cryptohopper panic semantics the 暫停下單 dialog was modeled
    on. Each close is the QUANTITY the book says the bot bought, capped at
    what the account actually holds on that side (a manually-shrunk position
    closes what exists). Only a legacy row — a book with no quantity, see
    lib.portfolio.ledger_book — still converts its USD at the mark. No
    baseline yet → no swap close at all (said loudly), never the whole account.
  - "self_ledger": false (explicit opt-out): EVERY open position on the
    account — the whole account is the bot's world, no ledger to scope by.

Semantics — panic button, not portfolio management:
  - HALT is (re)tripped here too, so a manual run gets the same guarantee:
    nothing re-opens after the flatten (only the user pressing 啟動下單 clears
    the halt). HALT freezes every order, so this process takes the close pass
    (guard.grant_halt_closes): its reduces — and the netted restore — go out,
    nothing else does. Exception: after a machine restart
    (lib/guard.RESTART_STOP_PATH) no HALT is added and the closes pass only on
    the one-time pass the platform's close_all hands us (guard.claim_close_all_pass);
    the machine stays stopped afterwards.
  - Venues are discovered like the account reader: {PREFIX}_API_KEY in .env,
    flattenable iff BOTH lib/account_{id}.py and lib/order_{id}.py exist.
    A venue with positions but no order lib is reported loudly and skipped.
  - Dust below the exchange minimum can't be closed (format_qty gate) — it is
    logged and left; the exchange rejects sub-minimum orders anyway.
  - SPOT: own positions only → each spot book row (ledger key "SYM@spot")
    sells min(book quantity, wallet); the wallet is one pool of the bot's and
    the user's coins, so the user's same-coin coins are never sold. A book row
    with no quantity (legacy) is not sold at all and says why. Opt-out → the
    managed inventory (lib/portfolio.spot_scope — strategy symbols +
    previously-managed) is sold to zero; personal coins in untargeted symbols
    are never touched. Spot dust below the venue's sell minimum is logged and
    left, same rule as swap.
  - SINGLE-FLIGHT. 暫停 and 全部平倉 are always pressable (a kill switch that
    greys out because the last press is still in flight is not a kill switch),
    so close_all IS re-sent — and a second flatten is not a harmless repeat.
    It re-reads positions, and every venue whose close cannot be expressed as
    reduce-only re-sends a plain market order into a book the first flatten is
    already emptying: on 群益 (lib/order_capital) the close is sNewClose=2
    「auto 新倉/平倉」, which on an already-closed position opens a NEW position
    the other way — and its positions come from lib/capital_worker's snapshot,
    good for up to 300s, so the second flatten doesn't even need to win a race
    to read a position that is already gone. (Crypto is narrower: the venue
    itself refuses the duplicate — reduceOnly on one-way/net, and in hedge mode
    positionSide/posSide pins the slot so an oversized close is rejected, never
    flipped — but it still doubles the orders.jsonl close legs the user reads
    as 交易歷史, and races zero_ledger_symbols.) So: one flatten per machine,
    enforced by state/flatten.lock; a second one exits immediately rather than
    queueing — the user pressing again means "stop faster", not "stop twice".
  - Every close is appended to manager/orders.jsonl with its confirmed fill,
    so the web 交易歷史 and the order toast show exactly what happened; the
    closed symbols' ledger baselines are zeroed afterwards
    (zero_ledger_symbols) so the closes are never re-summed as bot trades.
"""
import importlib
import inspect
import json
import logging
import os
import re
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import guard, venue_traits
from lib.portfolio import (_append_reconciler_log, _load_ledger_seed, _record_order_error,
                           ledger_positions, load_portfolio_config,
                           zero_ledger_symbols)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

_ENV_KEY_RE = re.compile(r"^\s*([A-Za-z0-9_]+)_API_KEY\s*=", re.IGNORECASE)
_RESERVED = {"BLAVE"}

LOCK_PATH = "state/flatten.lock"  # relative — this module chdir'd to the workspace above
ALREADY_RUNNING = "already_running"  # flatten()'s return when another one holds the lock
EXIT_ALREADY_RUNNING = 3  # ...and the exit code for it, distinct from 1 = ran with errors
_LOCK = None  # the open lock file, pinned for the life of the process (see _singleflight)


def _takes(fn, name):
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())


def _book_months(vid, ledger):
    """{key: contract months | None} the bot's book holds on a TW futures venue,
    or None (no book, not such a venue, a lib.portfolio without months)."""
    if ledger is None or not venue_traits.has(vid, "hand_wired"):
        return None
    try:
        from lib.portfolio import book_months_of
    except ImportError:
        return None
    return book_months_of(ledger)


def _singleflight(path=None):
    """Take the close-all lock (see the docstring's SINGLE-FLIGHT rule), or
    return None when another flatten already holds it — the caller must then
    exit, not wait.

    Never released by hand: the OS drops it on ANY exit, SIGKILL and reboot
    included, so there is no stale-lock case to reason about and nothing to
    clean up. The pid written inside is for humans reading state/, never for
    liveness. Same shape as runtime/local_daemon.SingleInstance.

    Fails OPEN: a platform with neither fcntl nor msvcrt runs the flatten
    unlocked. A panic button that refuses to close real positions because it
    could not take a lock is worse than the double-close the lock prevents.
    """
    path = path or LOCK_PATH
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = open(path, "a+")
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            return fh  # locking() holds a byte range — leave the file untouched
        import fcntl
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except ImportError:
        return fh
    except OSError:
        fh.close()
        return None
    try:
        fh.seek(0)
        fh.truncate()
        fh.write(str(os.getpid()))
        fh.flush()
    except OSError:
        pass  # the lock is the contract; the pid is a comment
    return fh


def _capital_order_identity_ok():
    """Can THIS process log in to 群益 SKCOM? On a cloud box only the built-in
    Administrator under a password-derived logon can (lib/order_capital.py › error 602):
    RDP/console (INTERACTIVE), schtasks /rp (BATCH), NSSM ObjectName (SERVICE).
    The web 全部平倉 runs us under the bridge's LocalSystem, a key-auth SSH
    session is a NETWORK/S4U logon — both 602. The identity is read from the
    process token, not env vars (the listener hands us a copied env); only
    which rule applies comes from BLAVE_AGENT_LOCAL, which the desktop daemon
    sets and the cloud listener strips (every BLAVE_*). Can't tell → False:
    a skipped 群益 close is recorded; a 602 attempt is not an honest answer.
    Known false positive: schtasks /ru Administrator WITHOUT /rp (/np, S4U)
    also carries BATCH but cannot unlock the cert — that case falls back to
    the pre-check behaviour (order attempted, 602, recorded as an error).
    Desktop app (BLAVE_AGENT_LOCAL=1, the daemon's flatten child): the
    signed-in user's INTERACTIVE logon, whatever the account is called.
    Mirrored in runtime/portfolio_reporter.py (can_flatten) — keep in step;
    tests/check_capital_flatten_identity.py fails if the two bodies differ."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        adv = ctypes.windll.advapi32
        # desktop app: SKCOM logs in as the signed-in user (the certificate is in their store) — any
        # account name, but only an INTERACTIVE logon; never the cloud's Administrator-only rule
        local = os.environ.get("BLAVE_AGENT_LOCAL") == "1"
        buf = ctypes.create_unicode_buffer(257)
        n = wintypes.DWORD(257)
        if not adv.GetUserNameW(buf, ctypes.byref(n)) or (not local and buf.value.lower() != "administrator"):
            return False
        # INTERACTIVE, BATCH, SERVICE
        for sddl in ("S-1-5-4",) if local else ("S-1-5-4", "S-1-5-3", "S-1-5-6"):
            sid = ctypes.c_void_p()
            if not adv.ConvertStringSidToSidW(sddl, ctypes.byref(sid)):
                return False
            member = wintypes.BOOL()
            try:
                ok = adv.CheckTokenMembership(None, sid, ctypes.byref(member))
            finally:
                ctypes.windll.kernel32.LocalFree(sid)
            if ok and member.value:
                return True
        return False
    except Exception:
        return False


# 群益 reports the RESOLVED contract (TM2610 = TM + YYMM); the reconciler books
# and logs the strategy symbol (manager/reconciler.py _CAPITAL_FUTURES_SPEC).
# Anchored on the full YYMM shape, not a prefix: TAIFEX option codes also start
# with TX (TXO/TX1..TX5 + strike + month letter) and must never become TXF.
_CAPITAL_BOOK_KEY = {"TX": "TXF", "MTX": "MXF", "TM": "TMF"}
_CAPITAL_FUT_RE = re.compile(r"^(MTX|TX|TM)(\d{2})(0[1-9]|1[0-2])$")


def _book_key(vid, sym):
    """The self-ledger / orders.jsonl key for a venue position row."""
    if venue_traits.has(vid, "resolved_contracts"):
        m = _CAPITAL_FUT_RE.match(sym)
        if m:
            return _CAPITAL_BOOK_KEY[m.group(1)]
    return sym


def _unknown_outcome(e, vid, sym, cid):
    """The close's lib/unconfirmed.OrderOutcomeUnknown — an older lib's plain OrderNotConfirmed
    rebuilt as one with this close's ids — or None."""
    import lib.portfolio as _pf
    u = getattr(_pf, "_unconfirmed", None)
    if u is None:
        return None
    if isinstance(e, u.OrderOutcomeUnknown):
        return e
    if not venue_traits.has(vid, "perp"):
        return None  # the TW brokers' unconfirmed fills are their own system (spec 4.7)
    wrap = getattr(u, "as_outcome_unknown", None)
    return wrap(e, vid, sym, cid) if wrap else None


def _book_cost(row, qty, fallback):
    """The book's cost of `qty` base of a ledger row — what a parked close takes off the book
    (lib/portfolio._settle_parked holds it back from the next reduce). Not the mark notional:
    below the entry price it would hold back too little and let the close go out again."""
    if row and not row.get("legacy") and float(row.get("qty") or 0) > 0:
        return abs(float(row.get("size") or 0)) * min(1.0, float(qty) / float(row["qty"]))
    if row and row.get("size") is not None:
        return abs(float(row["size"]))
    return abs(float(fallback or 0))


def _unparked_share(cost, held):
    """The part of a book row a close-all may still send, as a fraction: what a parked close
    holds back (`held`, its book cost) is left alone — reconcile's |book| − held. 1.0 = none
    held; 0 = all of it held."""
    if not held:
        return 1.0
    cost = abs(float(cost or 0))
    return max(0.0, cost - float(held)) / cost if cost > 0 else 0.0


def _read_env(path=".env"):
    from lib.venue_wiring import read_env
    return read_env(path)


def _venues(env):
    out = []
    for k in env:
        own = venue_traits.cred_env(k)  # 統一 is bound by president_account, not *_API_KEY
        if own:
            if own[1] == "API_KEY":
                out.append(own[0].lower())
            continue
        m = _ENV_KEY_RE.match(k + "=")
        # DATA_<SOURCE>_* = data-source keys, never a venue — same rule as
        # runtime/account_reader._venues (a venue literally named DATA stays)
        if not m or m.group(1).upper() in _RESERVED or m.group(1).upper().startswith("DATA_"):
            continue
        out.append(m.group(1).lower())
    # libs shipped but no account type verified: never traded, so nothing to flatten (and its
    # refusal must not fail the sweep of the venue that is)
    return sorted(set(out) - venue_traits.unverified())


def _flatten_spot(vid, order, env, book=None, parked_held=None):
    """Sell the bot's spot coins. `book` = the bot's spot book rows
    ({"SYM": ledger_positions() row}, own_positions_only): each sells
    min(book quantity, wallet) — the wallet is one pool of the bot's and the
    user's coins, so it is never sold down whole; a row with no quantity (a
    legacy row) is not sold and says why. `book` None = the explicit
    `"self_ledger": false` opt-out: the MANAGED inventory (spot_scope symbols)
    is sold to zero; personal coins in symbols no strategy ever targeted are
    never sold. Returns (closed, errors, closed_symbols, unclosed) — closed_symbols
    (market-suffixed "SYM@spot" keys) is every symbol actually sold OR left as
    dust, i.e. every symbol whose self-ledger baseline (if self_ledger is on)
    must be zeroed by the caller (see flatten()'s zero_ledger_symbols call —
    a real position closed here must never be summed into ledger_positions()
    as if it were an ordinary bot trade); unclosed = book keys still holding
    the bot's coins after this run (their book must keep describing them)."""
    from lib.portfolio import spot_scope
    from lib.venue_wiring import _spot_base
    closed = errors = 0
    closed_symbols, unclosed = set(), set()
    try:
        balances = order.get_spot_balances(env)

        def _inv(sym):
            amt = balances.get(_spot_base(sym), 0.0)
            return amt * order.get_spot_price(env, sym) if amt else 0.0

        scope = spot_scope(_inv) if book is None else {s: None for s in book}
    except Exception as e:
        logging.error(f"[{vid}] close-all spot: scope read failed: {e}")
        _record_order_error("*", vid, f"close-all spot: scope read failed: {e}")
        return closed, errors + 1, closed_symbols, set(f"{s}@spot" for s in (book or {}))
    for sym, usd in scope.items():
        amt = balances.get(_spot_base(sym), 0.0)
        if book is not None:
            row = book[sym] or {}
            if row.get("side") != "long":
                continue  # a spot book cannot be short: nothing of the bot's to sell
            qty = None if row.get("legacy") else row.get("qty")
            if qty is None:
                logging.error(f"[{vid}] {sym}: the bot's spot share has no quantity — not sold")
                _record_order_error(f"{sym}@spot", vid, "close-all spot: the bot's share of this "
                                    "coin has no recorded quantity, so it can't be told from "
                                    "yours — not sold; sell the bot's part yourself")
                errors += 1
                unclosed.add(f"{sym}@spot")
                continue
            amt = min(amt, float(qty))
        held_back = parked_held(f"{sym}@spot") if parked_held else 0.0
        if held_back:
            # a sale of unknown outcome is parked: only the rest of the bot's share is sold
            if book is not None:
                share = _unparked_share(book[sym].get("size"), held_back)
                amt = min(balances.get(_spot_base(sym), 0.0), float(book[sym]["qty"]) * share)
            else:
                share = _unparked_share(usd, held_back)
                amt *= share
            amt = float(f"{amt:.12g}")
            unclosed.add(f"{sym}@spot")  # its book keeps describing the parked part
            logging.warning(f"[{vid}] {sym} spot: a sale of unknown outcome is parked — selling "
                            f"{share:.0%} of the bot's share, the parked part is left")
        if amt <= 0:
            continue
        try:
            cid = f"flat{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
            result = order.place_spot_market_order(env, sym, "sell", base_qty=amt,
                                                   client_order_id=cid)
        except Exception as e:
            u = _unknown_outcome(e, vid, sym, cid)
            if u is not None:
                # the sale may have filled: parked, its key keeps its book until it is known
                import lib.portfolio as _pf
                cost = _book_cost(book.get(sym) if book is not None else None, amt, usd)
                _pf.park_or_halt(f"{sym}@spot", vid, u, -cost, True, sign=-1)
                unclosed.add(f"{sym}@spot")
                errors += 1
                continue
            d = _defer_tw_close(vid, f"{sym}@spot", e)
            if d:
                unclosed.add(f"{sym}@spot")
                errors += d == "refused"
                continue
            logging.error(f"[{vid}] close-all spot {sym} failed: {e}")
            _record_order_error(sym, vid, f"close-all spot: {e}")
            errors += 1
            continue
        if result is False:
            logging.info(f"[{vid}] {sym} spot {amt} below sell minimum — dust left")
            closed_symbols.add(f"{sym}@spot")  # dust is still "as flat as it gets"
            continue
        if usd is None:
            usd = amt * (result.get("avg_price") or 0)
        leg = {"signed_diff": -round(result.get("quote_qty") or usd, 2),
               "reduce_only": True, "exchange": vid}
        if result.get("avg_price") is not None:
            leg["fill_price"] = result["avg_price"]
        if result.get("executed_qty") is not None:
            leg["executed_qty"] = result["executed_qty"]
            leg["signed_qty"] = -float(result["executed_qty"])
        _append_reconciler_log({
            "action": "SELL",
            "symbol": f"{sym}@spot",
            "signed_diff": leg["signed_diff"],
            "exchange": vid,
            "asset_spec": None,
            "contributors": [],
            "legs": [leg],
        })
        got = result.get("executed_qty")
        if got is not None and float(got) + max(1e-12, amt * 1e-9) < amt:
            logging.error(f"[{vid}] {sym} spot: sold {got}/{amt} — the rest stays the bot's")
            _record_order_error(f"{sym}@spot", vid, f"close-all spot: {sym} 未平完(成交 {float(got):g} / "
                                                   f"{amt:g}),剩下的仍是 Blave 的")
            errors += 1
            unclosed.add(f"{sym}@spot")
            continue
        closed += 1
        closed_symbols.add(f"{sym}@spot")
        logging.info(f"[{vid}] sold spot {sym} ({amt})")
    return closed, errors, closed_symbols, unclosed


def _defer_tw_close(vid, key, exc):
    """A paper TW stock close refused because the TWSE session is shut
    (order_paper.PaperMarketClosed): handed to the reconciler's first round
    after the open (lib.portfolio.defer_paper_tw_close), said once on the
    page. The book keeps the position until then. Returns "deferred",
    "refused" (said, counted as an error) or None (any other error).

    After a machine restart (guard.restart_stopped) nothing is deferred: the
    reconciler skips every round while stopped, so no round after the open
    would close it — the page says to press close-all again in the session."""
    if type(exc).__name__ != "PaperMarketClosed":
        return None
    if guard.restart_stopped():
        logging.error(f"[{vid}] {key}: TW market closed and the machine is stopped after a restart — not deferred")
        _record_order_error(key, vid, "close-all: 台股休市中,而且機器重開後停止下單,無法排到開盤自動平倉——"
                                      "請在開盤後(09:00–13:30)再按一次全部平倉")
        return "refused"
    try:
        from lib.portfolio import defer_paper_tw_close
        defer_paper_tw_close([key])
    except Exception as e:
        logging.error(f"[{vid}] {key}: could not defer the close ({e})")
        return None
    logging.info(f"[{vid}] {key}: TW market closed — close deferred to the next session")
    _record_order_error(key, vid, "close-all: 台股休市中,開盤後第一輪平倉",
                        {"kind": "market_closed_deferred"})
    return "deferred"


def _restore_netted(vid, order, env, positions, ledger, closed_symbols, unclosed,
                    parked_held=None):
    """Close-all's twin of lib.venue_wiring._netted_exit: a book row whose side
    the account does not show, while the account holds the other side on a
    one-way venue, is the bot's entry netted into the user's position. The
    only close that exists is a PLAIN order of the book's recorded netted
    quantity (never more), which restores the user's position — HALT lets
    exactly that order through (lib.guard.netted_restore). Without a recorded
    netted amount nothing is sent here: the row is left to the normal pass,
    which leaves an account row that isn't the bot's alone. Returns (closed, errors)."""
    try:
        from lib.venue_wiring import _net_position_mode
    except ImportError:
        return 0, 0
    closed = errors = 0
    held = {}
    for p in positions:
        sym = (p.get("symbol") or "").replace("-", "").upper()
        if p.get("side") in ("long", "short"):
            held.setdefault(sym, {}).setdefault(p["side"], 0.0)
            held[sym][p["side"]] += float(p.get("size") or 0)
    for key, row in ledger.items():
        netted = float(row.get("netted") or 0)
        if netted <= 0 or row.get("legacy"):
            continue
        sym, side = key, row.get("side")
        other = "short" if side == "long" else "long"
        h = held.get(sym, {})
        if h.get(side) or not h.get(other):
            continue
        if _net_position_mode(order, vid, env, sym) is not True:
            continue
        qty = float(f"{min(netted, float(row.get('qty') or 0), h[other]):.12g}")
        held_back = parked_held(key) if parked_held else 0.0
        if held_back:
            # a close of unknown outcome is parked on this row: only what it leaves is restored
            qty = float(f"{qty * _unparked_share(row.get('size'), held_back):.12g}")
            unclosed.add(key)
            if qty <= 0:
                continue
        try:
            order.format_qty(env, sym, qty)
        except ValueError:
            logging.info(f"[{vid}] {sym}: netted share {qty} below minimum — left")
            continue
        cid = f"flat{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
        try:
            with guard.netted_restore(sym, other, qty, "flatten"):
                result = order.place_market_order(env, sym, other, qty, client_order_id=cid,
                                                  reduce_only=False)
        except Exception as e:
            u = _unknown_outcome(e, vid, sym, cid)
            if u is not None:
                import lib.portfolio as _pf
                u.netted_exit = True  # booked as the netted exit it is (venue_wiring._netted_exit)
                sign = -1 if side == "long" else 1
                _pf.park_or_halt(key, vid, u, sign * _book_cost(row, qty, 0), True, sign=sign)
                unclosed.add(key)
                errors += 1
                continue
            logging.error(f"[{vid}] restoring the netted {sym} failed: {e}")
            _record_order_error(key, vid, f"close-all: 還原被淨額的部位失敗: {e}")
            unclosed.add(key)
            errors += 1
            continue
        got = float((result or {}).get("executed_qty") or 0) if isinstance(result, dict) else 0.0
        price = float((result or {}).get("avg_price") or 0) if isinstance(result, dict) else 0.0
        sign = -1.0 if side == "long" else 1.0
        _append_reconciler_log({
            "action": "SELL" if side == "long" else "BUY", "symbol": key,
            "signed_diff": round(sign * got * price, 2), "exchange": vid, "asset_spec": None,
            "contributors": [],
            "legs": [{"signed_diff": round(sign * got * price, 2), "reduce_only": False,
                      "exchange": vid, "fill_price": price, "executed_qty": got,
                      "signed_qty": sign * got, "netted_exit": True}]})
        # the rest of the book row (not netted) is closed by the normal pass; only a
        # row that was wholly netted is done here
        if got + 1e-12 < qty:
            logging.error(f"[{vid}] {sym}: netted restore filled {got}/{qty}")
            _record_order_error(key, vid, f"close-all: 還原被淨額的部位未平完({got:g}/{qty:g})")
            unclosed.add(key)
            errors += 1
        elif abs(float(row.get("qty") or 0) - qty) <= 1e-12:
            closed_symbols.add(key)
            closed += 1
        logging.info(f"[{vid}] restored the user's {other} {sym}: sent {other} {got}")
    return closed, errors


def _inflight_wait_s():
    """How long close-all waits for in-flight executions. One 群益 futures order can take
    confirm_timeout (15 s) + lib.order_capital.LATE_REPORT_S (30 s) = 45 s before its fill
    is booked, and a reversal sends two such orders (close, then open) under one in-flight
    marker: 2 × 45 = 90 s. Waiting less closes over a book that hasn't heard of them yet.
    Not covered: a first SKCOM login inside the marker (~12 s) can push it past 90 s."""
    try:
        from lib.order_capital import LATE_REPORT_S
    except Exception:  # Windows-only deps / half-updated lib: assume the shipped 30 s
        LATE_REPORT_S = 30.0
    return 2 * (15.0 + float(LATE_REPORT_S))


def _wait_for_inflight(timeout_s=30.0, poll_s=1.0, symbol=None):
    """After HALT is tripped, give in-flight TWAP/chase/custom executions a
    moment to drain before closing over them (audit P1 #4): flatten and a
    still-running execution firing orders on the same symbol can over-close.
    HALT stops executions of either direction at their next slice; one stuck
    in a venue call may outlive the wait — after the timeout we proceed anyway
    (a panic close must not block forever) but say so loudly, per symbol.
    symbol: only that swap symbol's executions (manager/close_symbol.py)."""
    from lib.execute import list_inflight

    def _pending():
        rows = list_inflight()
        if symbol is None:
            return rows
        return [m for m in rows if str(m.get("key") or "") == symbol]

    label = "close-all" if symbol is None else "close_symbol"
    deadline = time.time() + timeout_s
    remaining = _pending()
    while remaining and time.time() < deadline:
        time.sleep(poll_s)
        remaining = _pending()
    for m in remaining:
        logging.error(f"{label}: execution still in flight for "
                      f"{m.get('key')} ({m.get('style')}) — closing over it; "
                      f"its later slices may re-move this symbol")
        _record_order_error(str(m.get('key') or '?'), '*',
                            f"{label} overlapped in-flight {m.get('style')}")
    return remaining


# 群益 / 統一: the worker's position snapshot lags an order sent on this machine. A read that STARTED less than
# ORDER_SETTLE_S after the last send still shows the old open interest — on 群益's auto open/close (sNewClose=2)
# a second close on it opens the reverse. That is exactly what a second flatten right after another one would
# do (a turn's flatten that waited for the turn lock while the 全部平倉 button's flatten closed everything), so
# a venue with a last-order marker is read only once its snapshot has caught up; past the wait it is not closed.
SETTLE_WAIT_S = 90.0
# From an agent turn the wait shares one budget across venues: hold_turn_money (guard.TURN_MONEY_WAIT_S) +
# in-flight drain (_inflight_wait_s) + this must stay under the timeout parallel_rule asks for manager/flatten.py
# (tests/check_turn_money_lock.py pins the sum). The 全部平倉 button's flatten (no turn) waits the full 90 s per venue.
TURN_SETTLE_BUDGET_S = 25.0


class _SnapshotLag(RuntimeError):
    pass


def _refresh_snapshot(vid):
    """Ask the venue's worker for an early re-read (best effort: the worker's own poll still covers it)."""
    try:
        getattr(importlib.import_module(f"lib.order_{vid}"), "_request_snapshot_refresh")()
    except Exception:
        pass


def _settle_marker(vid):
    """(ORDER_SETTLE_S, last_order_at) for a venue whose snapshot lags its sends, else None."""
    if vid == "capital":
        from lib import capital_vault
        return capital_vault.ORDER_SETTLE_S, capital_vault.last_order_at
    if vid == "president":
        from lib import president_vault

        def last():
            return importlib.import_module("lib.order_president").last_order_at()
        return president_vault.ORDER_SETTLE_S, last
    return None


def _wait_snapshot_settled(vid, acct, wait_s=None, poll_s=2.0):
    """Wait (up to SETTLE_WAIT_S) until `vid`'s snapshot read started ≥ ORDER_SETTLE_S after the last send on this
    machine. Raises _SnapshotLag past the wait, or when the marker / snapshot cannot be read (fail closed: an
    unknown position is not closed)."""
    if not hasattr(acct, "get_query_started_at"):
        return
    try:
        m = _settle_marker(vid)
    except Exception as e:
        raise _SnapshotLag(f"last-order marker unavailable ({type(e).__name__}: {str(e)[:120]})")
    if m is None:
        return
    settle_s, last_order_at = m
    deadline = time.time() + (SETTLE_WAIT_S if wait_s is None else wait_s)
    asked = False
    while True:
        try:
            last, q = last_order_at(), acct.get_query_started_at()
        except Exception as e:
            raise _SnapshotLag(f"position snapshot / last-order marker unreadable ({type(e).__name__}: {str(e)[:120]})")
        if not last or q >= last + settle_s:
            return
        if not asked:
            _refresh_snapshot(vid)   # the worker re-reads early once the send has settled
            asked = True
        if time.time() >= deadline:
            raise _SnapshotLag(f"snapshot read started at {q:.0f}, last order at {last:.0f} — needs a read "
                               f"{settle_s} s after it")
        time.sleep(poll_s)


def _kick_reconciler():
    """state/execution/kick is a watched mtime: the reconciler re-reads actuals
    within one poll and rewrites manager/last_reconcile.json — the positions
    column the page shows. Without it the closes sit unseen until the 5-minute
    heartbeat (29026, 2026-09-24: sold at 03:51:41, shown as held until
    03:56:42). Under the HALT that round places nothing; it only re-reads."""
    try:
        from lib.execute import _touch_kick
        _touch_kick()
    except Exception as e:
        logging.warning(f"close-all: reconciler kick failed ({e})")


def flatten():
    """Returns True (flat, no errors), False (ran, hit errors) or
    ALREADY_RUNNING (did nothing — another flatten holds the lock).

    Runs holding the park lock (lib/unconfirmed.hold): no other process may settle a parked
    order meanwhile. A fill found by the reconciler between this run's ledger zeroing and its
    end would otherwise be booked after the zeroing — open, not closed, and not reported
    (re-audit v034 R-P2-3). The opening settle books what can be found before anything is
    closed; whatever is still parked at the end gets its row. The reconciler gives up on the
    lock after a few seconds and skips that round (lib/unconfirmed.LOCK_TIMEOUT_S); it is
    halted anyway.

    The single-flight lock comes FIRST and the park lock only after it: a second press must
    exit at once, not queue behind the first and close everything again (third audit T-P1 —
    群益's auto open/close would open the reverse of a close not yet confirmed)."""
    global _LOCK
    # From an agent turn: another turn's order / close on this machine finishes first, and only then are the
    # positions read (lib/guard). BEFORE the single-flight lock: a turn's flatten waiting here must not hold
    # flatten.lock, or the user's 全部平倉 button (the daemon's flatten, no turn lock) would see it taken,
    # exit as ALREADY_RUNNING and close nothing while this one waits and then gives up. Busy past the wait →
    # nothing closed by this run, one error row saying why.
    try:
        guard.hold_turn_money()
    except guard.TurnMoneyBusy as e:
        logging.error(f"close-all: {e}")
        _record_order_error("*", "*", f"close-all: {e}")
        return False
    _LOCK = _singleflight()
    if _LOCK is None:
        # Deliberately before the HALT trip: whoever holds the lock tripped it
        # already, and command_listener._cmd_close_all trips it synchronously
        # before launching us — the stop half of the button is never skipped.
        logging.info(f"close-all: another flatten holds {LOCK_PATH} — this one exits")
        return ALREADY_RUNNING
    try:
        import lib.portfolio as _pf
        hold = _pf._unconfirmed.hold if getattr(_pf, "_unconfirmed", None) is not None else None
    except Exception:
        hold = None
    if hold is None or not callable(hold):
        return _flatten()
    with hold():
        return _flatten()


def _flatten():
    env = _read_env()
    if guard.restart_stopped():
        # Machine restarted, trading stays stopped: only the user's close_all may
        # close, through the pass command_listener._cmd_close_all wrote just
        # before launching us. No pass (a hand/agent run) → nothing can close;
        # say so instead of sending orders that will all be refused. No HALT:
        # the restart record already keeps everything else from re-opening.
        if not guard.claim_close_all_pass():
            _record_order_error("*", "*", "close-all: machine restarted — trading is stopped; "
                                "close positions at the exchange yourself (啟動下單 resumes "
                                "trading, it does not close)")
            logging.info("close-all: restart stop without a close-all pass — nothing closed")
            return False
    elif not guard.halted():
        guard.trip_halt("close all positions", "flatten")
    guard.grant_halt_closes("flatten")
    _wait_for_inflight(timeout_s=_inflight_wait_s())
    closed = errors = 0
    # self_ledger scope (see module docstring): ON → close only the bot's own
    # SWAP book; the user's manual positions are untouched even here. Spot
    # stays on the inventory scope either way — spot_scope already limits it
    # to strategy-targeted symbols, and spot+self_ledger has not been
    # integrated/live-tested yet (swap-only feature as shipped 2026-08-20).
    import lib.portfolio as _pf
    # an order parked with an unknown outcome (lib/unconfirmed): ask the venue first, so a
    # fill that can be found now is in the book this close reads, and closed with it
    parked_before = _pf._settle_parked() if hasattr(_pf, "_settle_parked") else {}
    # (venue, key) → the book cost a parked CLOSE holds back (entries hold none): the part a
    # close-all leaves alone until its outcome is known. venue None = every venue.
    parked_held = {}
    try:
        if parked_before is None:
            raise RuntimeError("park file unreadable")
        rows = (_pf._unconfirmed.read_held().values()
                if getattr(_pf, "_unconfirmed", None) is not None else [])
    except Exception as e:
        # which closes may already be out is unknown: none is sent (reconcile skips its round)
        logging.error(f"close-all: parked orders unreadable ({e}) — nothing closed")
        _record_order_error("*", "*", "close-all: 結果不明的單的紀錄讀不到，這次沒有平倉。"
                                      "請稍後再按一次，或到交易所核對部位。")
        return False
    for e in rows:
        if isinstance(e, dict) and e.get("key") and e.get("reduce_only"):
            k = (e.get("venue"), e["key"])
            parked_held[k] = parked_held.get(k, 0.0) + abs(float(e.get("signed_diff") or 0))
    for k, v in parked_before.items():
        if v == float("inf"):  # a park a full disk refused: all of it held
            parked_held[(None, k)] = v

    def _held(vid, key):
        return parked_held.get((vid, key), 0.0) + parked_held.get((None, key), 0.0)
    cfg = load_portfolio_config()
    own = _pf.own_positions_only(cfg) if hasattr(_pf, "own_positions_only") else cfg.get("self_ledger")
    per_venue = hasattr(_pf, "book_ready")  # a lib whose book is kept per venue
    ready = _pf.book_ready(cfg) if per_venue else bool(_load_ledger_seed()["seeded_at"])
    if own and not ready:
        # No baseline yet (the reconciler writes it on its first round under
        # this rule): an unseeded book replays the whole order history, and the
        # account read is bot and user mixed — neither may pick what to close.
        logging.error("close-all: no ledger baseline yet — the bot's positions can't be told "
                      "from the user's; swap and spot closes skipped")
        _record_order_error("*", "*", "close-all: no ledger baseline yet — Blave can't tell its "
                                      "positions from yours; close them at the exchange")
    if own and ready and hasattr(_pf, "claim_unvenued_rows"):
        try:
            # rows from before books were per venue belong to the venue the machine
            # trades on — never to every bound venue (a second venue's same symbol
            # is the user's)
            _pf.claim_unvenued_rows()
        except Exception as e:
            logging.error(f"close-all: could not claim rows without a venue ({e})")
    book_failed = []

    def _venue_book(vid):
        """(swap book, spot book) of this venue — the bot's share ON THIS VENUE
        only (another venue's book is not a position here: on a second bound
        venue the same symbol is the user's). None = the account-read opt-out."""
        if not own:
            return None, None
        if not ready:
            return {}, {}
        if hasattr(_pf, "book_account_check"):
            # the book is this venue's only if the key still opens the account it
            # was built on — else it would sell another account's positions
            try:
                verdict, detail = _pf.book_account_check(env, vid)
            except Exception as e:
                verdict, detail = "unreadable", f"{vid} book account check failed ({type(e).__name__})"
            if verdict in ("unreadable", "transient"):
                logging.error(f"close-all: {detail} — {vid} closes skipped")
                _record_order_error(vid, "*", f"close-all: {detail}")
                return {}, {}
            if verdict == "reset":
                logging.warning(f"close-all: {detail} — nothing of the bot's to close on {vid}")
        try:
            book = ledger_positions(vid) if per_venue else ledger_positions()
        except Exception as e:
            # Panic path: an unreadable ledger must not turn the button into a
            # no-op, but silently widening scope to the WHOLE account would
            # close the manual positions the rule exists to protect — so close
            # nothing, loudly.
            if not book_failed:
                logging.error(f"close-all: ledger unreadable ({e}) — swap and spot closes skipped")
                _record_order_error("*", "*", f"close-all: ledger unreadable: {e}")
            book_failed.append(vid)
            return {}, {}
        return ({s: r for s, r in book.items() if not s.endswith("@spot")},
                {s[:-5]: r for s, r in book.items() if s.endswith("@spot")})
    # Every symbol actually closed (or left as sub-minimum dust) here, across
    # every venue — zeroed in the self-ledger at the end regardless of whether
    # self_ledger is currently on (see zero_ledger_symbols docstring). Without
    # this, a self_ledger account would sum flatten's own closing orders into
    # ledger_positions() as if they were ordinary bot trades, driving the
    # ledger to a phantom position it never held and the NEXT reconcile would
    # then try to "correct" — right after the user asked to close everything.
    # per venue (the book is): {vid: keys}
    closed_by, unclosed_by, swept_by = {}, {}, {}
    # bot book keys whose position is still open after this run (skipped or
    # failed) — the end-of-run ledger sweep must not zero them, or 啟動下單
    # re-buys the whole target on top of the position that is still there
    # False once any venue's positions went unread or unclosable: ledger keys
    # carry no venue, so the stale-entry sweep can't tell that venue's book apart
    sweep_ok = True
    # one settle-wait budget for the whole run when this is an agent turn (TURN_SETTLE_BUDGET_S); None = per venue
    settle_end = time.time() + TURN_SETTLE_BUDGET_S if os.environ.get("BLAVE_TURN_INTERRUPT_FILE") else None
    for vid in _venues(env):
        closed_symbols = closed_by.setdefault(vid, set())
        unclosed = unclosed_by.setdefault(vid, set())
        ledger, spot_book = _venue_book(vid)
        if ledger:
            swept_by[vid] = set(ledger)
        has_account = os.path.isfile(f"lib/account_{vid}.py")
        has_order = os.path.isfile(f"lib/order_{vid}.py")
        if not has_account:
            if has_order:
                # can trade but can't be read: its positions (and so which book
                # keys are still open) are unknown
                logging.error(f"[{vid}] has lib/order_{vid}.py but no account lib — positions unread")
                _record_order_error("*", vid, f"close-all: no account_{vid} lib — positions not read, "
                                              "not closed")
                errors += 1
                sweep_ok = False
            continue
        try:
            acct = importlib.import_module(f"lib.account_{vid}")
            _wait_snapshot_settled(vid, acct, wait_s=None if settle_end is None else max(0.0, settle_end - time.time()))
            months_by_key = _book_months(vid, ledger)
            if months_by_key is not None and _takes(acct.get_positions, "book_months"):
                # TW futures: only the contract months the book holds are the bot's
                positions = acct.get_positions(env, book_months=months_by_key)
            else:
                months_by_key = None
                positions = acct.get_positions(env)
        except _SnapshotLag as e:
            logging.error(f"[{vid}] position snapshot has not caught up with the last order: {e} — not closed")
            # a deliberate skip with positions possibly still open = P1 (.claude/docs/notifications.md,
            # manual_close_required): the user must hear it; the raw times stay in the log, not in the row
            keys = ",".join(sorted(ledger)) if ledger else ""
            if ledger:
                unclosed |= set(ledger)
            _record_order_error(keys or "*", vid,
                                "close-all: 部位快取還沒跟上剛才送出的單,這一次沒有平這家(避免把舊部位再平一次變成反向開倉),"
                                "請稍後再按一次全部平倉,或到券商下單軟體手動平倉 / positions here were not closed: the "
                                "position snapshot has not caught up with the order just sent (closing on it again could "
                                "open the reverse). Press Close all again in a minute, or close at the broker.",
                                {"kind": "manual_close_required", "symbols": keys, "reason": "snapshot_lag"})
            errors += 1
            sweep_ok = False
            continue
        except Exception as e:
            logging.error(f"[{vid}] get_positions failed: {e}")
            _record_order_error("*", vid, f"close-all: get_positions failed: {e}")
            errors += 1
            sweep_ok = False
            continue
        # Agent-written account libs sometimes return the reconciler dict shape
        # ({symbol: {side, size}}) instead of the contract list — iterating a
        # dict yields key strings and would crash the whole flatten. Adapt.
        if isinstance(positions, dict):
            positions = [{"symbol": k, **(v if isinstance(v, dict) else {})}
                         for k, v in positions.items()]
        if positions and not has_order:
            logging.error(f"[{vid}] HAS POSITIONS but no lib/order_{vid}.py — cannot flatten")
            _record_order_error("*", vid, f"close-all: positions exist but no order_{vid} lib")
            errors += 1
            sweep_ok = False
            continue
        if venue_traits.has(vid, "windows_identity") and positions and not _capital_order_identity_ok():
            # never "try and see" under the wrong identity (HALT above still holds).
            # ONE merged row naming every skipped key: order_errors keeps only 5, so
            # a row per position would push real crypto failures out
            skipped = set()
            for p in positions:
                key = _book_key(vid, str(p.get("symbol") or "*").upper())
                if ledger is not None:
                    led = ledger.get(key)
                    if not led or led.get("side") != p.get("side"):
                        continue  # not the bot's — flatten would leave it anyway
                unclosed.add(key)
                skipped.add(key)
                logging.error(f"[{vid}] {key} NOT closed — this process cannot log in to SKCOM")
                errors += 1
            if skipped:
                keys = ",".join(sorted(skipped))
                _record_order_error(keys, vid, "close-all: 群益部位未平倉(此身分無法登入群益 API),"
                                               "請在群益下單軟體手動平倉",
                                    {"kind": "manual_close_required", "symbols": keys,
                                     "reason": "identity"})
            continue
        try:
            order = importlib.import_module(f"lib.order_{vid}") if has_order else None
        except Exception as e:   # one venue's lib failing to load stops only that venue's close
            logging.error(f"[{vid}] lib.order_{vid} failed to load: {e}")
            _record_order_error("*", vid, f"close-all: lib.order_{vid} failed to load ({type(e).__name__}: "
                                          f"{str(e)[:200]}) — this venue not closed")
            unclosed |= {_book_key(vid, str(p.get("symbol") or "*").upper()) for p in (positions or [])}
            errors += 1
            sweep_ok = False
            continue
        # managed SPOT inventory sells down too(2026-08-05「現貨也賣掉」)—
        # must run even when swap is flat, so no early-continue before it
        if order is not None and hasattr(order, "place_spot_market_order"):
            c2, e2, s2, u2 = _flatten_spot(vid, order, env, spot_book,
                                           lambda k, vid=vid: _held(vid, k))
            closed += c2
            errors += e2
            closed_symbols |= s2
            unclosed |= u2
        if not positions:
            continue
        if ledger:
            # the bot's netted share (a one-way account merged its entry into the
            # user's opposite position): give the user their position back first
            c3, e3 = _restore_netted(vid, order, env, positions, ledger, closed_symbols, unclosed,
                                     lambda k, vid=vid: _held(vid, k))
            closed += c3
            errors += e3
        for p in positions:
            # One bad row must not abort the rest of the flatten — every branch
            # below either closes, records dust, or records a visible error.
            sym = ""
            cid = None
            lots_row = False
            try:
                sym = (p.get("symbol") or "").replace("-", "").upper()
                key = _book_key(vid, sym)
                side, size = p.get("side"), float(p.get("size", 0))
                if not sym or side not in ("long", "short") or size <= 0:
                    logging.error(f"[{vid}] unflattenable row skipped: {p!r:.120}")
                    if sym:
                        _record_order_error(key, vid, f"close-all: bad position row (side={side})")
                        errors += 1
                        unclosed.add(key)
                    else:
                        sweep_ok = False  # a row we can't even name may be any book key
                    continue
                price = float(p.get("mark_price", 0) or 0)
                if ledger is not None:
                    # ledger scope: close min(bot's book, what's actually held
                    # on that side) — never the account row itself. A row the
                    # ledger doesn't claim (manual position, or the bot's book
                    # is on the other side) is left completely alone.
                    led = ledger.get(key)
                    if not led or led.get("side") != side:
                        logging.info(f"[{vid}] {sym} {side} {size} not the bot's — untouched")
                        continue
                    # no 'qty' at all = a lib.portfolio from before the
                    # quantity book (files reach a machine one at a time)
                    qty = None if led.get("legacy") else led.get("qty")
                    if qty is not None:
                        # the bot's own quantity — no price in between, so the
                        # close is what was bought whatever the mark did since
                        size = min(size, float(qty))
                    elif not price:
                        # can't convert the ledger's USD book to base units —
                        # skipping is the safe direction (never widen to the
                        # account row, that's the manual-position bite)
                        logging.error(f"[{vid}] {sym}: no mark price — bot close skipped")
                        _record_order_error(key, vid, "close-all: no mark price for ledger scope")
                        errors += 1
                        unclosed.add(key)
                        continue
                    else:
                        size = min(size, float(led["size"]) / price)
                held_back = _held(vid, key)
                if held_back:
                    # a close of unknown outcome is parked on it: only the rest is closed —
                    # resending the parked part could take the user's own position too
                    if ledger is None:
                        share = _unparked_share(size * price, held_back)
                        size *= share
                    else:
                        share = _unparked_share(led.get("size"), held_back)
                        bot_qty = (float(led["qty"]) if led.get("qty") is not None and not led.get("legacy")
                                   else float(led["size"]) / price)
                        size = min(float(p.get("size", 0)), bot_qty * share)
                    size = float(f"{size:.12g}")
                    unclosed.add(key)  # its book keeps describing the parked part
                    logging.warning(f"[{vid}] {key}: a close of unknown outcome is parked — "
                                    f"closing {share:.0%} of it, the parked part is left")
                    if size <= 0:
                        continue
                # Known, accepted (Wei): a non-near-month row is still sent — the
                # close goes out as the near-month alias, so during a roll it can
                # open the near month instead of closing the far one.
                if venue_traits.has(vid, "resolved_contracts") and not _CAPITAL_FUT_RE.match(sym):
                    logging.error(f"[{vid}] {sym}: not a TX/MTX/TM futures contract — not sent")
                    _record_order_error(key, vid, f"close-all: 群益非期貨部位({sym}),"
                                                  "請在群益下單軟體手動平倉")
                    errors += 1
                    unclosed.add(key)
                    continue
                # a lots position (futures_contracts / shares — paper reports it
                # with unit "contracts") is closed by its lot count: a notional
                # close would be refused, or sized wrong
                lots_row = p.get("unit") == "contracts" and not venue_traits.has(vid, "lots_close_partial")
                cid = f"flat{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
                if lots_row:
                    if not hasattr(order, "place_contract_market_order"):
                        raise RuntimeError(f"{sym}: a lots position, and lib.order_{vid} has no "
                                           f"lots close")
                    size = float(int(round(size)))
                    if size <= 0:
                        logging.info(f"[{vid}] {sym} {side}: under one lot — nothing to close")
                        closed_symbols.add(key)
                        continue
                    result = order.place_contract_market_order(
                        env, sym, side, int(size), p.get("contract_value") or 1.0,
                        client_order_id=cid, reduce_only=True)
                else:
                    try:
                        # step/min_qty gate ONLY — deliberately no price arg: with
                        # it format_qty also enforces MIN_NOTIONAL, which Binance
                        # EXEMPTS for reduce-only orders, so a perfectly closable
                        # position would be left behind as "dust" (audit S2). A
                        # venue that does reject the close reports it as a visible
                        # error below, not a silent leave.
                        order.format_qty(env, sym, size)
                    except ValueError:
                        logging.info(f"[{vid}] {sym} {side} {size} below minimum — dust left")
                        closed_symbols.add(key)  # dust is still "as flat as it gets"
                        continue
                    kw = {}
                    if months_by_key is not None and _takes(order.close_position_partial, "book_months"):
                        kw["book_months"] = months_by_key.get(key, set())
                    result = order.close_position_partial(env, sym, side, size, client_order_id=cid, **kw)
            except Exception as e:
                u = _unknown_outcome(e, vid, sym, cid) if sym else None
                if u is not None:
                    # the close may have filled: parked, its key keeps its book until it is known
                    led = ledger.get(_book_key(vid, sym)) if ledger is not None else None
                    cost = _book_cost(led, size, float(size) * float(p.get("mark_price", 0) or 0))
                    _pf.park_or_halt(_book_key(vid, sym), vid, u,
                                     (-1.0 if side == "long" else 1.0) * cost,
                                     True, sign=-1 if side == "long" else 1)
                    unclosed.add(_book_key(vid, sym))
                    errors += 1
                    continue
                d = _defer_tw_close(vid, _book_key(vid, sym), e) if sym else None
                if d:
                    unclosed.add(_book_key(vid, sym))
                    errors += d == "refused"
                    continue
                logging.error(f"[{vid}] close {p.get('symbol')} failed: {e}")
                _record_order_error(_book_key(vid, sym) if sym else "?", vid, f"close-all: {e}")
                errors += 1
                if sym:
                    unclosed.add(_book_key(vid, sym))
                continue
            # what the venue actually filled: a canceled-with-fill close (OKX
            # _confirm returns those) is a partial close, and its remainder is
            # still the bot's
            got = (float(result["executed_qty"]) if isinstance(result, dict)
                   and result.get("executed_qty") is not None else None)
            done_qty = size if got is None else got
            fill_px = float(result.get("avg_price") or 0) if isinstance(result, dict) else 0.0
            # a lots book counts lots (qty == cost, like capital); everything else the notional
            notional = done_qty if lots_row else (round(done_qty * (fill_px or price), 2)
                                                  if (fill_px or price) else None)
            leg = {"signed_diff": (-notional if side == "long" else notional) if notional else None,
                   "reduce_only": True, "exchange": vid}
            if isinstance(result, dict):
                if result.get("avg_price") is not None:
                    leg["fill_price"] = result["avg_price"]
                if result.get("executed_qty") is not None:
                    leg["executed_qty"] = result["executed_qty"]
                    # the quantity half of the book: a partial close reduces it by
                    # exactly what filled (the zeroing below then skips this key)
                    leg["signed_qty"] = -got if side == "long" else got
                if result.get("resolved_symbol") and result.get("executed_qty"):
                    leg["resolved_symbol"] = result["resolved_symbol"]  # the month that closed
            _append_reconciler_log({
                "action": "SELL" if side == "long" else "BUY",
                "symbol": key,
                "signed_diff": leg["signed_diff"],
                "exchange": vid,
                "asset_spec": None,
                "contributors": [],
                "legs": [leg],
            })
            if venue_traits.has(vid, "close_needs_fill") and (
                    not isinstance(result, dict) or result.get("status") != "filled"
                    or float(result.get("executed_qty") or 0) + 1e-9 < size):
                # 'sent' = accepted, no fill seen within the timeout — may or
                # may not have filled; never book an unconfirmed close as flat
                got = result.get("executed_qty") if isinstance(result, dict) else None
                logging.error(f"[{vid}] {sym}: close not confirmed filled ({got}/{size})")
                label = venue_traits.get(vid, "label") or vid
                _record_order_error(key, vid, f"close-all: {label}平倉未確認成交({got or 0}/{size:g} 口),"
                                              f"請到{label}下單軟體確認部位")
                errors += 1
                unclosed.add(key)
                continue
            if got is not None and got + max(1e-12, size * 1e-9) < size:
                logging.error(f"[{vid}] {sym}: close filled {got}/{size} — the rest stays the bot's")
                _record_order_error(key, vid, f"close-all: {sym} 未平完(成交 {got:g} / {size:g}),"
                                              "剩下的仍是 Blave 的部位")
                errors += 1
                unclosed.add(key)
                continue
            closed += 1
            closed_symbols.add(key)
            logging.info(f"[{vid}] closed {side} {sym} ({size})")
    for vid in closed_by:
        done = set(closed_by[vid])
        if sweep_ok:
            # flatten's contract is "the bot's book is empty afterwards" — zero
            # every ledger symbol, including one whose account row was already
            # gone (user closed it by hand earlier; the stale book entry must not
            # survive the button that promises a clean slate) — except a position
            # this run left open, whose book must keep describing it
            done |= swept_by.get(vid, set())
        # a key with one row closed and another left open is still open
        if per_venue:
            zero_ledger_symbols(done - unclosed_by[vid], venue=vid)
        else:
            zero_ledger_symbols(done - unclosed_by[vid])
    # no settle here: flatten() holds the park lock (see there), so what was parked after the
    # opening settle is still parked now — its fill, if any, is booked only after this run.
    # One row per order left out (designer v034 UX P1-2): close_all marks the 「沒有一起平倉」
    # kind; park_id / inflight_id let it end in place once the order is known.
    left = []   # (key, venue, {"park_id": …} or {"inflight_id": …})
    try:
        for pid, e in _pf._unconfirmed.read_held().items():
            if e.get("key"):
                left.append((e["key"], e.get("venue"), {"park_id": pid}))
    except Exception:
        left = [(k, None, {}) for k in sorted(parked_before or {}) if k]
    # an order still in flight (its marker survived _wait_for_inflight) may have an outcome
    # nobody knows yet either — the same row, so 全部平倉 never reads as flat over it
    try:
        from lib.execute import _INFLIGHT_DIR
        for f in sorted(os.listdir(_INFLIGHT_DIR)):
            if f.endswith(".json"):
                try:
                    with open(os.path.join(_INFLIGHT_DIR, f)) as fh:
                        mk = str(json.load(fh).get("key") or "").split("#")[0]
                except (OSError, ValueError):
                    continue
                if mk:
                    left.append((mk, None, {"inflight_id": f[:-5]}))
    except (ImportError, OSError):
        pass
    for key, venue, ident in left:
        _record_order_error(key, venue or "*",
                            "close-all: 這個標的有一筆結果不明的單，那部分沒平。"
                            "請到交易所核對部位。",
                            extra={"kind": "order_unconfirmed", "stuck": True, "close_all": True, **ident})
        errors += 1
    if any(unclosed_by.values()):
        # a close accepted but not confirmed filled (群益) is still in the book;
        # the reconciler's capital positions snapshot is up to 300 s old, so a
        # round kicked now sees it as held and sends a second reduce leg — on
        # capital sNewClose=2 opens the reverse. The heartbeat is late enough
        # for the snapshot to refresh first.
        logging.warning("close-all: positions left open — the heartbeat re-reads, no kick")
    else:
        _kick_reconciler()
    logging.info(f"flatten done: {closed} closed, {errors} errors")
    return errors == 0


if __name__ == "__main__":
    # the user's close: 群益 logs in now, not after the reconciler's re-login backoff (lib/order_capital)
    os.environ["BLAVE_CAPITAL_OWN_BACKOFF"] = "1"
    _result = flatten()
    sys.exit(EXIT_ALREADY_RUNNING if _result == ALREADY_RUNNING else (0 if _result else 1))
