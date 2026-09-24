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
    nothing re-opens after the flatten (closes always pass the guard; only the
    user pressing 啟動下單 clears the halt). Exception: after a machine restart
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
import logging
import os
import re
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import guard
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
    """Can THIS process log in to 群益 SKCOM? Only the built-in Administrator
    under a password-derived logon can (lib/order_capital.py › error 602):
    RDP/console (INTERACTIVE), schtasks /rp (BATCH), NSSM ObjectName (SERVICE).
    The web 全部平倉 runs us under the bridge's LocalSystem, a key-auth SSH
    session is a NETWORK/S4U logon — both 602. Read from the process token,
    not env vars (the listener hands us a copied env). Can't tell → False:
    a skipped 群益 close is recorded; a 602 attempt is not an honest answer.
    Known false positive: schtasks /ru Administrator WITHOUT /rp (/np, S4U)
    also carries BATCH but cannot unlock the cert — that case falls back to
    the pre-check behaviour (order attempted, 602, recorded as an error).
    Mirrored in runtime/portfolio_reporter.py (can_flatten) — keep in step;
    tests/check_capital_flatten_identity.py fails if the two bodies differ."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        adv = ctypes.windll.advapi32
        buf = ctypes.create_unicode_buffer(257)
        n = wintypes.DWORD(257)
        if not adv.GetUserNameW(buf, ctypes.byref(n)) or buf.value.lower() != "administrator":
            return False
        for sddl in ("S-1-5-4", "S-1-5-3", "S-1-5-6"):  # INTERACTIVE, BATCH, SERVICE
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
    if vid == "capital":
        m = _CAPITAL_FUT_RE.match(sym)
        if m:
            return _CAPITAL_BOOK_KEY[m.group(1)]
    return sym


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
        # DATA_<SOURCE>_* = data-source keys, never a venue — same rule as
        # runtime/account_reader._venues (a venue literally named DATA stays)
        if not m or m.group(1).upper() in _RESERVED or m.group(1).upper().startswith("DATA_"):
            continue
        out.append(m.group(1).lower())
    return sorted(set(out))


def _flatten_spot(vid, order, env, book=None):
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


def _restore_netted(vid, order, env, positions, ledger, closed_symbols, unclosed):
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
        try:
            order.format_qty(env, sym, qty)
        except ValueError:
            logging.info(f"[{vid}] {sym}: netted share {qty} below minimum — left")
            continue
        try:
            with guard.netted_restore(sym, other, qty, "flatten"):
                result = order.place_market_order(
                    env, sym, other, qty,
                    client_order_id=f"flat{datetime.utcnow().strftime('%Y%m%d%H%M%S%f')}",
                    reduce_only=False)
        except Exception as e:
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
    _wait_for_inflight()
    closed = errors = 0
    # self_ledger scope (see module docstring): ON → close only the bot's own
    # SWAP book; the user's manual positions are untouched even here. Spot
    # stays on the inventory scope either way — spot_scope already limits it
    # to strategy-targeted symbols, and spot+self_ledger has not been
    # integrated/live-tested yet (swap-only feature as shipped 2026-08-20).
    import lib.portfolio as _pf
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
            positions = acct.get_positions(env)
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
        if vid == "capital" and positions and not _capital_order_identity_ok():
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
        order = importlib.import_module(f"lib.order_{vid}") if has_order else None
        # managed SPOT inventory sells down too(2026-08-05「現貨也賣掉」)—
        # must run even when swap is flat, so no early-continue before it
        if order is not None and hasattr(order, "place_spot_market_order"):
            c2, e2, s2, u2 = _flatten_spot(vid, order, env, spot_book)
            closed += c2
            errors += e2
            closed_symbols |= s2
            unclosed |= u2
        if not positions:
            continue
        if ledger:
            # the bot's netted share (a one-way account merged its entry into the
            # user's opposite position): give the user their position back first
            c3, e3 = _restore_netted(vid, order, env, positions, ledger, closed_symbols, unclosed)
            closed += c3
            errors += e3
        for p in positions:
            # One bad row must not abort the rest of the flatten — every branch
            # below either closes, records dust, or records a visible error.
            sym = ""
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
                # Known, accepted (Wei): a non-near-month row is still sent — the
                # close goes out as the near-month alias, so during a roll it can
                # open the near month instead of closing the far one.
                if vid == "capital" and not _CAPITAL_FUT_RE.match(sym):
                    logging.error(f"[{vid}] {sym}: not a TX/MTX/TM futures contract — not sent")
                    _record_order_error(key, vid, f"close-all: 群益非期貨部位({sym}),"
                                                  "請在群益下單軟體手動平倉")
                    errors += 1
                    unclosed.add(key)
                    continue
                # a lots position (futures_contracts / shares — paper reports it
                # with unit "contracts") is closed by its lot count: a notional
                # close would be refused, or sized wrong
                lots_row = p.get("unit") == "contracts" and vid != "capital"
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
                    result = order.close_position_partial(env, sym, side, size, client_order_id=cid)
            except Exception as e:
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
            _append_reconciler_log({
                "action": "SELL" if side == "long" else "BUY",
                "symbol": key,
                "signed_diff": leg["signed_diff"],
                "exchange": vid,
                "asset_spec": None,
                "contributors": [],
                "legs": [leg],
            })
            if vid == "capital" and (not isinstance(result, dict) or result.get("status") != "filled"
                                     or float(result.get("executed_qty") or 0) + 1e-9 < size):
                # 'sent' = accepted, no fill seen within the timeout — may or
                # may not have filled; never book an unconfirmed close as flat
                got = result.get("executed_qty") if isinstance(result, dict) else None
                logging.error(f"[{vid}] {sym}: close not confirmed filled ({got}/{size})")
                _record_order_error(key, vid, f"close-all: 群益平倉未確認成交({got or 0}/{size:g} 口),"
                                              "請到群益下單軟體確認部位")
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
    logging.info(f"flatten done: {closed} closed, {errors} errors")
    return errors == 0


if __name__ == "__main__":
    _result = flatten()
    sys.exit(EXIT_ALREADY_RUNNING if _result == ALREADY_RUNNING else (0 if _result else 1))
