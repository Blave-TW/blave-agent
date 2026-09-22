"""Flatten: market-close the BOT's positions on every connected venue.

The web 暫停並全部平倉 runs this (the command listener trips state/HALT first,
then launches this detached); it is also runnable by hand:

    cd workspace && python3 manager/flatten.py

Scope — what "the bot's positions" means depends on self_ledger
(portfolio_config.json, Wei 2026-08-20):
  - self_ledger ON: ONLY the bot's own ledger positions
    (lib.portfolio.ledger_positions) are closed — the user's manual positions
    on the same account are never touched, not even by this button. Matches
    the 3Commas/Cryptohopper panic semantics the 暫停下單 dialog was modeled
    on. Each close is the QUANTITY the book says the bot bought, capped at
    what the account actually holds on that side (a manually-shrunk position
    closes what exists). Only a legacy row — a book with no quantity, see
    lib.portfolio.ledger_book — still converts its USD at the mark.
  - self_ledger OFF (every pre-feature machine): EVERY open position on the
    account — under the old alignment logic the whole account is the bot's
    world, and there is no ledger to scope by.

Semantics — panic button, not portfolio management:
  - HALT is (re)tripped here too, so a manual run gets the same guarantee:
    nothing re-opens after the flatten (closes always pass the guard; only the
    user pressing 啟動下單 clears the halt).
  - Venues are discovered like the account reader: {PREFIX}_API_KEY in .env,
    flattenable iff BOTH lib/account_{id}.py and lib/order_{id}.py exist.
    A venue with positions but no order lib is reported loudly and skipped.
  - Dust below the exchange minimum can't be closed (format_qty gate) — it is
    logged and left; the exchange rejects sub-minimum orders anyway.
  - SPOT inventory in the managed scope (lib/portfolio.spot_scope — strategy
    symbols + previously-managed) is sold down too; personal coins in
    untargeted symbols are never touched. Spot dust below the venue's sell
    minimum is logged and left, same rule as swap. (self_ledger ON: spot
    strategies' ledger keys carry the @spot suffix and are closed from the
    ledger like everything else.)
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
import logging
import os
import re
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import guard
from lib.portfolio import (_append_reconciler_log, _record_order_error,
                           ledger_positions, load_portfolio_config,
                           zero_ledger_symbols)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

_ENV_KEY_RE = re.compile(r"^\s*([A-Za-z0-9_]+)_API_KEY\s*=", re.IGNORECASE)
_RESERVED = {"BLAVE"}

LOCK_PATH = "state/flatten.lock"  # relative — this module chdir'd to the workspace above
ALREADY_RUNNING = "already_running"  # flatten()'s return when another one holds the lock
EXIT_ALREADY_RUNNING = 3  # ...and the exit code for it, distinct from 1 = ran with errors
_LOCK = None  # the open lock file, pinned for the life of the process (see _singleflight)


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


def _read_env(path=".env"):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return env


def _venues(env):
    out = []
    for k in env:
        m = _ENV_KEY_RE.match(k + "=")
        if not m or m.group(1).upper() in _RESERVED:
            continue
        out.append(m.group(1).lower())
    return sorted(set(out))


def _flatten_spot(vid, order, env):
    """Sell the venue's MANAGED spot inventory (spot_scope symbols) to zero.
    Personal coins in symbols no strategy ever targeted are not in scope and
    are never sold. Returns (closed, errors, closed_symbols) — closed_symbols
    (market-suffixed "SYM@spot" keys) is every symbol actually sold OR left as
    dust, i.e. every symbol whose self-ledger baseline (if self_ledger is on)
    must be zeroed by the caller (see flatten()'s zero_ledger_symbols call —
    a real position closed here must never be summed into ledger_positions()
    as if it were an ordinary bot trade)."""
    from lib.portfolio import spot_scope
    from lib.venue_wiring import _spot_base
    closed = errors = 0
    closed_symbols = set()
    try:
        balances = order.get_spot_balances(env)

        def _inv(sym):
            amt = balances.get(_spot_base(sym), 0.0)
            return amt * order.get_spot_price(env, sym) if amt else 0.0

        scope = spot_scope(_inv)
    except Exception as e:
        logging.error(f"[{vid}] close-all spot: scope read failed: {e}")
        _record_order_error("*", vid, f"close-all spot: scope read failed: {e}")
        return closed, errors + 1, closed_symbols
    for sym, usd in scope.items():
        amt = balances.get(_spot_base(sym), 0.0)
        if amt <= 0:
            continue
        try:
            cid = f"flat{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
            result = order.place_spot_market_order(env, sym, "sell", base_qty=amt,
                                                   client_order_id=cid)
        except Exception as e:
            logging.error(f"[{vid}] close-all spot {sym} failed: {e}")
            _record_order_error(sym, vid, f"close-all spot: {e}")
            errors += 1
            continue
        if result is False:
            logging.info(f"[{vid}] {sym} spot {amt} below sell minimum — dust left")
            closed_symbols.add(f"{sym}@spot")  # dust is still "as flat as it gets"
            continue
        leg = {"signed_diff": -round(result.get("quote_qty") or usd, 2),
               "reduce_only": True, "exchange": vid}
        if result.get("avg_price") is not None:
            leg["fill_price"] = result["avg_price"]
        if result.get("executed_qty") is not None:
            leg["executed_qty"] = result["executed_qty"]
        _append_reconciler_log({
            "action": "SELL",
            "symbol": f"{sym}@spot",
            "signed_diff": leg["signed_diff"],
            "exchange": vid,
            "asset_spec": None,
            "contributors": [],
            "legs": [leg],
        })
        closed += 1
        closed_symbols.add(f"{sym}@spot")
        logging.info(f"[{vid}] sold spot {sym} ({amt})")
    return closed, errors, closed_symbols


def _wait_for_inflight(timeout_s=30.0, poll_s=1.0, symbol=None):
    """After HALT is tripped, give in-flight TWAP/chase/custom executions a
    moment to drain before closing over them (audit P1 #4): flatten and a
    still-running execution firing orders on the same symbol can over-close.
    HALT already stops entry executions at their next slice; reduce ones may
    legitimately outlive the wait — after the timeout we proceed anyway (a
    panic close must not block forever) but say so loudly, per symbol.
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


def flatten():
    """Returns True (flat, no errors), False (ran, hit errors) or
    ALREADY_RUNNING (did nothing — another flatten holds the lock)."""
    global _LOCK
    _LOCK = _singleflight()
    if _LOCK is None:
        # Deliberately before the HALT trip: whoever holds the lock tripped it
        # already, and command_listener._cmd_close_all trips it synchronously
        # before launching us — the stop half of the button is never skipped.
        logging.info(f"close-all: another flatten holds {LOCK_PATH} — this one exits")
        return ALREADY_RUNNING
    env = _read_env()
    if not guard.halted():
        guard.trip_halt("close all positions", "flatten")
    _wait_for_inflight()
    closed = errors = 0
    # self_ledger scope (see module docstring): ON → close only the bot's own
    # SWAP book; the user's manual positions are untouched even here. Spot
    # stays on the inventory scope either way — spot_scope already limits it
    # to strategy-targeted symbols, and spot+self_ledger has not been
    # integrated/live-tested yet (swap-only feature as shipped 2026-08-20).
    ledger = None
    if load_portfolio_config().get("self_ledger"):
        try:
            ledger = {sym: row for sym, row in ledger_positions().items()
                      if not sym.endswith("@spot")}
        except Exception as e:
            # Panic path: an unreadable ledger must not turn the button into a
            # no-op, but silently widening scope to the WHOLE account would
            # close the manual positions self_ledger exists to protect — so
            # close nothing on swap, loudly.
            logging.error(f"close-all: ledger unreadable ({e}) — swap closes skipped")
            _record_order_error("*", "*", f"close-all: ledger unreadable: {e}")
            ledger = {}
    # Every symbol actually closed (or left as sub-minimum dust) here, across
    # every venue — zeroed in the self-ledger at the end regardless of whether
    # self_ledger is currently on (see zero_ledger_symbols docstring). Without
    # this, a self_ledger account would sum flatten's own closing orders into
    # ledger_positions() as if they were ordinary bot trades, driving the
    # ledger to a phantom position it never held and the NEXT reconcile would
    # then try to "correct" — right after the user asked to close everything.
    closed_symbols = set()
    for vid in _venues(env):
        has_account = os.path.isfile(f"lib/account_{vid}.py")
        has_order = os.path.isfile(f"lib/order_{vid}.py")
        if not has_account:
            continue  # no reader — nothing to see here either
        try:
            acct = importlib.import_module(f"lib.account_{vid}")
            positions = acct.get_positions(env)
        except Exception as e:
            logging.error(f"[{vid}] get_positions failed: {e}")
            _record_order_error("*", vid, f"close-all: get_positions failed: {e}")
            errors += 1
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
            continue
        order = importlib.import_module(f"lib.order_{vid}") if has_order else None
        # managed SPOT inventory sells down too(2026-08-05「現貨也賣掉」)—
        # must run even when swap is flat, so no early-continue before it
        if order is not None and hasattr(order, "place_spot_market_order"):
            c2, e2, s2 = _flatten_spot(vid, order, env)
            closed += c2
            errors += e2
            closed_symbols |= s2
        if not positions:
            continue
        for p in positions:
            # One bad row must not abort the rest of the flatten — every branch
            # below either closes, records dust, or records a visible error.
            try:
                sym = (p.get("symbol") or "").replace("-", "").upper()
                side, size = p.get("side"), float(p.get("size", 0))
                if not sym or side not in ("long", "short") or size <= 0:
                    logging.error(f"[{vid}] unflattenable row skipped: {p!r:.120}")
                    if sym:
                        _record_order_error(sym, vid, f"close-all: bad position row (side={side})")
                        errors += 1
                    continue
                price = float(p.get("mark_price", 0) or 0)
                if ledger is not None:
                    # ledger scope: close min(bot's book, what's actually held
                    # on that side) — never the account row itself. A row the
                    # ledger doesn't claim (manual position, or the bot's book
                    # is on the other side) is left completely alone.
                    led = ledger.get(sym)
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
                        _record_order_error(sym, vid, "close-all: no mark price for ledger scope")
                        errors += 1
                        continue
                    else:
                        size = min(size, float(led["size"]) / price)
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
                    closed_symbols.add(sym)  # dust is still "as flat as it gets"
                    continue
                cid = f"flat{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}"
                result = order.close_position_partial(env, sym, side, size, client_order_id=cid)
            except Exception as e:
                logging.error(f"[{vid}] close {p.get('symbol')} failed: {e}")
                _record_order_error(str(p.get("symbol") or "?"), vid, f"close-all: {e}")
                errors += 1
                continue
            notional = round(size * price, 2) if price else None
            leg = {"signed_diff": (-notional if side == "long" else notional) if notional else None,
                   "reduce_only": True, "exchange": vid}
            if isinstance(result, dict):
                if result.get("avg_price") is not None:
                    leg["fill_price"] = result["avg_price"]
                if result.get("executed_qty") is not None:
                    leg["executed_qty"] = result["executed_qty"]
            _append_reconciler_log({
                "action": "SELL" if side == "long" else "BUY",
                "symbol": sym,
                "signed_diff": leg["signed_diff"],
                "exchange": vid,
                "asset_spec": None,
                "contributors": [],
                "legs": [leg],
            })
            closed += 1
            closed_symbols.add(sym)
            logging.info(f"[{vid}] closed {side} {sym} ({size})")
    if ledger:
        # flatten's contract is "the bot's book is empty afterwards" — zero
        # every ledger symbol, including one whose account row was already
        # gone (user closed it by hand earlier; the stale book entry must not
        # survive the button that promises a clean slate)
        closed_symbols |= set(ledger)
    zero_ledger_symbols(closed_symbols)
    logging.info(f"flatten done: {closed} closed, {errors} errors")
    return errors == 0


if __name__ == "__main__":
    _result = flatten()
    sys.exit(EXIT_ALREADY_RUNNING if _result == ALREADY_RUNNING else (0 if _result else 1))
