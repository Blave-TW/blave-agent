"""
Trading guard: filesystem kill switch + append-only order audit log.

Why this exists: every safety rule in AGENTS.md (verify-then-report,
iteration brakes) runs through the model following instructions. This is the
one brake that does NOT: if the file state/HALT exists, no order leaves this
machine, regardless of what the agent believes it is doing.
lib/order_*.py enforces it inside the transport layer, so every path that
uses the lib — strategies, reconciler, TWAP slices, ad-hoc scripts — is
covered without any caller opting in.

HALT semantics — a full freeze (Wei 2026-10-17, 0.1.27):
- Blocked while halted: every order — entries, reduces and closes, a flip's
  close leg, protective SL/TP. The reconciler sends nothing; a strategy's
  exit waits for 啟動下單 like its entry does. Orders already resting on the
  exchange are the exchange's and are left alone.
- Still allowed: cancels and leverage changes (they open and close nothing;
  an execution being stopped must still pull its own resting order).
- The one way to close under HALT is an explicit user close: manager/flatten.py
  (the 暫停並關閉部位 button) and manager/close_symbol.py hold the close pass
  (grant_halt_closes), and a close-all leg the reconciler finishes for flatten
  (paper TW stocks after hours) runs inside halt_close_pass. Reduces only — plus
  the one armed netted restore, which gives the user back what the bot netted.
- The file's EXISTENCE is authoritative. Its JSON content ({ts, reason,
  source}) is attribution only — a malformed or hand-touched HALT file still
  halts (fail-closed).

Who trips it: the user (e.g. "全部停止" → agent runs trip_halt), a safety
check that finds the book or the account in doubt (reconciler, execute,
portfolio, settings), or anyone creating state/HALT by hand. Every one of
those wants nothing to move: a close sized off a book in doubt is itself an
order in doubt. Clearing requires an explicit user instruction — the agent
must NEVER clear a halt on its own initiative.

Audit log: state/audit.jsonl — one JSON line per order attempt, outcome,
halt denial, and halt change, fsynced per line so it survives a crash.
audit() never raises: a protective order must not fail because the audit
disk write did (errors are logged and swallowed — the one sanctioned
exception to the no-silent-failure rule, and only for the LOG write).
"""

import atexit
import json
import logging
import os
import threading
import time
try:
    from lib.winreplace import atomic_replace
except ImportError:  # half-updated workspace (lib/winreplace.py not landed): plain replace
    atomic_replace = os.replace
try:
    from lib.winreplace import load_json
except ImportError:  # half-updated workspace (lib/winreplace.py without load_json): no read retry
    def load_json(path, **open_kw):
        with open(path, **open_kw) as f:
            return json.load(f)
from datetime import datetime, timezone

HALT_PATH = "state/HALT"
AUDIT_PATH = "state/audit.jsonl"

# In-memory halt flag (2026-08-20 audit): trip_halt's own file write can fail
# under exactly the condition that most needs a halt — a full disk (measured
# on the fleet) fails the orders.jsonl append AND the HALT write in the same
# breath, and without this flag the reconcile loop keeps re-buying the fill
# its ledger never recorded, every round, unbounded. The flag halts THIS
# process even when the file can't land; the file remains authoritative for
# every other process and across restarts. Never cleared except by
# clear_halt — same one-way semantics as the file.
_halt_flag = False


class Halted(Exception):
    """Raised instead of sending an order while state/HALT exists (or the
    restart stop / an account hold refuses it)."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def halted():
    return _halt_flag or os.path.exists(HALT_PATH)


# ── netted restore: the one non-reduce order a close pass lets through ─────
# On a one-way account the bot's entry may have been netted into the user's
# opposite position (lib.venue_wiring._netted_exit). Undoing it is a plain,
# non-reduce order of at most the recorded netted quantity — the only way to
# give the user their position back. A flatten under HALT must not leave the
# user's position at the bot's size, so the caller opens this pass for THAT order: this thread
# only, one order only, and only the symbol, direction and at most the quantity
# it names. Each order lib's place_market_order offers its own order
# (arm_restore) before sending; entry_blocked() lets through only an armed
# pass, and spends it. Audited. The machine-restart stop still blocks it:
# after a reboot nothing trades.
_restore = threading.local()


def _canon_symbol(symbol):
    return str(symbol or "").upper().replace("-", "").replace("_", "").replace("/", "")


class netted_restore:
    def __init__(self, symbol, direction, qty, source):
        self.fields = {"symbol": symbol, "direction": direction, "qty": float(qty),
                       "source": source}

    def __enter__(self):
        _restore.pass_ = {**self.fields, "armed": False, "spent": False}
        audit("netted_restore", **self.fields)
        return self

    def __exit__(self, *exc):
        _restore.pass_ = None
        return False


def arm_restore(symbol, direction, qty, reduce_only=False):
    """An order lib's place_market_order, about to send (symbol, direction =
    the position it builds, qty in the caller's units): arms this thread's open
    pass when the order is exactly the restore it was opened for."""
    p = getattr(_restore, "pass_", None)
    if not p or p["spent"] or reduce_only:
        return
    if (_canon_symbol(symbol) == _canon_symbol(p["symbol"]) and direction == p["direction"]
            and 0 < float(qty) <= p["qty"] * (1 + 1e-9) + 1e-12):
        p["armed"] = True


def entry_blocked():
    """HALT blocks an entry order — except the one armed netted restore (which
    check_restart_stop lets this far only inside a close pass)."""
    if not halted():
        return False
    p = getattr(_restore, "pass_", None)
    if p and p["armed"] and not p["spent"]:
        p["armed"], p["spent"] = False, True
        return False
    return True


# ── machine-restart stop (Wei 2026-09-22) ────────────────────────────────────
# Written by the runtime when the machine rebooted while trading
# (runtime/command_listener.RESTART_STOP_PATH — same file; the runtime ships on
# its own channel, so the string is repeated there and a check pins them equal),
# removed only by the user's 啟動下單. Unlike HALT it blocks EVERY order —
# entries, closes, reduces, SL/TP — from every caller that uses lib/order_*
# (reconciler, TWAP/chase slices, Type B strategies, ad-hoc scripts): after a
# reboot nothing trades until the user says so. Cancels and leverage changes
# still pass: neither opens nor closes anything, and a cancel only lowers risk.
RESTART_STOP_PATH = "state/reconciler_stopped.json"
# cancel/leverage change nothing held; "reset" = order_paper.reset_account, the
# user wiping their simulated book — not an order.
_RESTART_PASS = frozenset({"cancel", "cancel_all", "leverage", "reset"})

# The one exception (Wei 2026-09-22): the user's own close_all (the web's 暫停並關閉部位) still closes while
# the machine stays stopped. command_listener._cmd_close_all writes this pass
# right before launching manager/flatten.py; flatten claims it (claim_close_all_pass),
# which lets THAT process's reduce orders through — nothing else, no entry, no
# SL/TP, no other process. Strategies and the reconciler never hold it.
CLOSE_ALL_PASS_PATH = "state/close_all_pass.json"
CLOSE_ALL_PASS_TTL_S = 120
_close_all_granted = False


def restart_stopped():
    return os.path.exists(RESTART_STOP_PATH)


def claim_close_all_pass():
    """manager/flatten.py only (tests/check_restart_stop_order_gate.py enumerates
    every caller). True = this process may close positions during a restart stop.
    The rename is atomic, so exactly one process consumes a pass; a pass older
    than CLOSE_ALL_PASS_TTL_S is void. Code running as this user could forge the
    file — but it could equally delete RESTART_STOP_PATH, so the pass adds no
    power it did not already have, and it is reachable through no argument,
    environment variable or public lib path."""
    global _close_all_granted
    claimed = f"{CLOSE_ALL_PASS_PATH}.{os.getpid()}"
    try:
        os.rename(CLOSE_ALL_PASS_PATH, claimed)
    except OSError:
        return False
    try:
        with open(claimed) as f:
            ts = json.load(f).get("ts")
        ok = isinstance(ts, (int, float)) and 0 <= time.time() - ts <= CLOSE_ALL_PASS_TTL_S
    except (OSError, ValueError, AttributeError):
        ok = False
    finally:
        try:
            os.remove(claimed)
        except OSError:
            pass
    if ok:
        _close_all_granted = True
    audit("close_all_pass_claimed" if ok else "close_all_pass_void")
    return ok


def _order_label(fields):
    return (fields.get('symbol') or fields.get('instId') or fields.get('contract')
            or fields.get('currency_pair') or '?')


def check_restart_stop(intent, fields=None):
    """Every order-lib gate calls this before its own HALT check: raises Halted
    for any order intent while the restart record exists, and — the HALT
    freeze — while state/HALT exists. `fields` = the audit dict."""
    fields = fields or {}
    if intent in _RESTART_PASS:
        return
    if restart_stopped():
        if not (_close_all_granted and intent == "reduce"):
            audit("order_denied_restart", **{**fields, "intent": intent})
            raise Halted(
                f"the machine restarted and trading is stopped until the user presses "
                f"啟動下單 — {intent} order for {_order_label(fields)} "
                f"refused before reaching the venue (closes included). Never remove "
                f"{RESTART_STOP_PATH} yourself.")
        audit("order_allowed_close_all", **{**fields, "intent": intent})
    _check_halt_freeze(intent, fields)


# ── HALT close pass: the user's explicit close while trading is paused ───────
# Process-wide for a process that exists only to close (manager/flatten.py,
# manager/close_symbol.py — tests/check_halt_freeze.py enumerates the callers);
# thread-local for one close-all leg the reconciler finishes for flatten. Same
# trust argument as claim_close_all_pass: code running as this user could just
# as well delete state/HALT, so the pass adds no power — it keeps the freeze
# from being bypassed by accident, not by intent.
_halt_closes_granted = False
_halt_close_local = threading.local()


def grant_halt_closes(source):
    """manager/flatten.py and manager/close_symbol.py only: this process may
    send reduce orders (and flatten's armed netted restore) under HALT."""
    global _halt_closes_granted
    _halt_closes_granted = True
    audit("halt_close_pass_granted", source=source)


class halt_close_pass:
    """One close-all leg on this thread (lib.portfolio.reconcile, flatten's
    deferred paper TW closes): reduces pass HALT inside the block."""

    def __init__(self, symbol, source):
        self.symbol, self.source = symbol, source

    def __enter__(self):
        _halt_close_local.on = True
        return self

    def __exit__(self, *exc):
        _halt_close_local.on = False
        return False


def halt_closes_allowed():
    return _halt_closes_granted or getattr(_halt_close_local, "on", False)


_FREEZE_BLOCKS = frozenset(("entry", "reduce", "protective"))


def _check_halt_freeze(intent, fields):
    if intent not in _FREEZE_BLOCKS or not halted():
        return
    if halt_closes_allowed() and intent in ("reduce", "entry"):
        # entry goes on to the lib's entry_blocked(): only an armed netted restore passes
        if intent == "reduce":
            audit("order_allowed_halt_close", **{**fields, "intent": intent})
        return
    audit("order_denied_halt", **{**fields, "intent": intent})
    raise Halted(
        f"state/HALT is set ({halt_info()}) — trading is paused: no order of any kind "
        f"(entries, closes, SL/TP) is sent until the user presses 啟動下單. "
        f"{intent} order for {_order_label(fields)} refused before reaching the venue. "
        f"Closing while paused is the user's explicit close (暫停並關閉部位, or "
        f"closing that one symbol). Only the user may clear the halt.")


def protection_halted_text(symbol, direction, wanted, placed, after_entry):
    """ProtectionFailed text when HALT refused SL/TP (order libs' place_protective_orders):
    names only what is actually missing, and the entry only when there was one."""
    names = {"sl": "stop-loss", "tp": "take-profit"}
    missing = [names[k] for k in wanted if k not in placed]
    done = [names[k] for k in wanted if k in placed]
    what = " and ".join(missing) + (" were" if len(missing) > 1 else " was")
    if after_entry:
        head = (f"{symbol} {direction} position is OPEN WITH NO STOP-LOSS"
                if "sl" in wanted and "sl" not in placed else f"{symbol} {direction} position is open")
        head += f": the entry filled, then trading was paused (state/HALT) and its {what} not placed"
    else:
        head = f"{symbol} {direction}: the {what} not placed — trading is paused (state/HALT)"
    if done:
        head += f"; the {' and '.join(done)} went out before the pause"
    return (f"{head}. A paused machine sends no order and nothing places it later on its own — "
            f"tell the user now; after they press 啟動下單, place it with place_protective_orders.")


# ── account hold: an unconfirmed exchange account gets no order at all ───────
# manager/reconciler writes it (state/venue_account.json): a `book_hold` for a
# venue — the bound key's account could not be matched to the one the bot's
# positions are on — or a `pending` account-changed trip while HALT stands.
# Until the user answers / presses 啟動下單, NO Blave order reaches that venue:
# not an entry, not a close, not a protective order — a close there could sell
# the user's own position on another account. This is what the report's
# `halt.holds_all` promises, so it is enforced where every order passes: each
# order lib's gate (check_account_hold), and lib.execute before each child
# order of a running TWAP / chase. Cancels are not orders and still pass.
ACCOUNT_GUARD_PATH = "state/venue_account.json"
_HOLD_BLOCKS = frozenset(("entry", "reduce", "protective"))


def account_held(venue):
    if venue == "paper":
        return False  # the simulated account is never someone else's
    try:
        state = load_json(ACCOUNT_GUARD_PATH)
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        return True  # unreadable guard state: fail closed, like HALT
    if not isinstance(state, dict) or not venue:
        return False
    hold = state.get("book_hold")
    if isinstance(hold, dict) and hold.get("venue") == venue:
        return True
    # an account-changed trip (or a bind that found one, before the reconciler
    # took it over) holds while its HALT stands
    pending, mark = state.get("pending"), state.get("bind_reset")
    return ((isinstance(pending, dict) and pending.get("venue") == venue)
            or (isinstance(mark, dict) and mark.get("venue") == venue
                and not mark.get("acked"))) and halted()


def check_account_hold(venue, intent, fields=None):
    """Every order-lib gate calls this next to check_restart_stop."""
    if intent not in _HOLD_BLOCKS or not account_held(venue):
        return
    fields = fields or {}
    audit("order_denied_account_hold", **{**fields, "intent": intent, "venue": venue})
    raise Halted(
        f"{venue}: the bound key's exchange account is not confirmed as the one "
        f"Blave's positions are on — no order is sent there until the user answers "
        f"the account question and presses 啟動下單 ({intent} refused before "
        f"reaching the venue)")


def halt_info():
    """Attribution dict from the HALT file, or None if not halted.
    Unreadable content still counts as halted — existence is what matters."""
    if not halted():
        return None
    try:
        return load_json(HALT_PATH)
    except Exception:
        return {"reason": "HALT file present but unreadable"}


def trip_halt(reason, source):
    """Set the kill switch. source: who tripped it — 'user' / 'healthcheck' /
    a strategy name. The in-memory flag is set FIRST so this process is
    halted even if the file write below fails (full disk); the write failure
    still propagates so callers know the halt did not persist machine-wide."""
    global _halt_flag
    _halt_flag = True
    os.makedirs(os.path.dirname(HALT_PATH), exist_ok=True)
    tmp = HALT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"ts": _now(), "reason": reason, "source": source}, f)
    atomic_replace(tmp, HALT_PATH)
    audit("halt_tripped", reason=reason, source=source)


def clear_halt(source):
    """Remove the kill switch. Only on explicit user instruction."""
    global _halt_flag
    _halt_flag = False
    if os.path.exists(HALT_PATH):
        os.remove(HALT_PATH)
    audit("halt_cleared", source=source)


def release_memory_halt():
    """Drop THIS process's in-memory halt flag; file and audit log untouched.
    Only for a long-running process that saw state/HALT land on disk and then
    saw another process remove it — the web resume runs clear_halt in the
    command listener, which cannot reach this flag, so without this a daemon
    that tripped its own HALT refuses entries until it is restarted. A HALT
    whose file write failed (full disk) was never seen on disk and must never
    be released this way."""
    global _halt_flag
    _halt_flag = False


# ── Per-strategy halt (scoped kill switch) ───────────────────────────────────
# A strategy's own circuit breaker must NOT trip the machine-wide HALT above —
# that single file freezes EVERY strategy sharing the order lib. Instead a
# strategy trips its own scoped halt (state/HALT_<strategy>), which only that
# strategy's own code/monitor checks before opening new exposure. The global
# HALT stays reserved for the user's explicit "全部停止" / kill-switch instruction.
#
# MONITOR-ONLY: lib/order_* and the reconciler never read the scoped file — an
# order sent by code that doesn't call halted_for() goes through. It is a flag
# the strategy honours, not a transport-level brake like state/HALT.
# (Shape and names match the version agents already wrote on the fleet, so
# strategies importing trip_halt_for / halted_for keep working after an update.)

def halt_path_for(strategy):
    """Filesystem path of one strategy's scoped halt file."""
    return f"{HALT_PATH}_{strategy}"


def halted_for(strategy):
    """True if the GLOBAL kill switch is set, OR this strategy's own halt.
    Existence of the scoped file is authoritative (fail-closed), same as the
    global file. Deliberately never False under the global HALT."""
    return halted() or os.path.exists(halt_path_for(strategy))


def halt_info_for(strategy):
    """Attribution dict for a scoped halt, or None. Global halt takes
    precedence; an unreadable scoped file still counts as halted."""
    if halted():
        return halt_info()
    if not os.path.exists(halt_path_for(strategy)):
        return None
    try:
        return load_json(halt_path_for(strategy))
    except Exception:
        return {"reason": "scoped HALT present but unreadable"}


def trip_halt_for(strategy, reason, source):
    """Set a strategy's OWN halt. Never touches the global HALT, so other
    strategies (and the user's kill switch) are unaffected."""
    os.makedirs(os.path.dirname(HALT_PATH), exist_ok=True)
    tmp = halt_path_for(strategy) + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"ts": _now(), "reason": reason, "source": source}, f)
    atomic_replace(tmp, halt_path_for(strategy))
    audit("halt_tripped", reason=reason, source=source, scope=strategy)


def clear_halt_for(strategy, source):
    """Remove a strategy's scoped halt. Only on explicit user instruction."""
    if os.path.exists(halt_path_for(strategy)):
        os.remove(halt_path_for(strategy))
    audit("halt_cleared", source=source, scope=strategy)


# The chat's Stop (runtime/turn_stop.py) kills the agent's tools but spares any process
# marked here. Every lib/order_* marks its process at import, for the process's whole
# life — not per request: the dangerous moment is BETWEEN requests (stop-loss cancelled,
# position not yet closed; filled, ledger not yet written). Anchored to this file, not
# the cwd: an agent script can run from anywhere, turn_stop reads <workspace>/state.
MONEY_PID_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "state", "execution", "money_pids")
_money_marked = False


def mark_money_process():
    global _money_marked
    if _money_marked:
        return
    _money_marked = True
    path = os.path.join(MONEY_PID_DIR, str(os.getpid()))
    try:
        os.makedirs(MONEY_PID_DIR, exist_ok=True)
        with open(path, "w") as f:
            f.write(_own_created())
        atexit.register(_unmark_money_process, path)
    except OSError as e:
        logging.warning(f"guard: money-process marker write failed: {e}")


def _own_created():
    """Windows: this process's creation time (FILETIME ticks), so turn_stop can tell this marker
    from one left by a hard-killed process whose pid was reused. "" elsewhere or on failure
    (turn_stop then counts the marker as it always did)."""
    if os.name != "nt":
        return ""
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        k32.GetProcessTimes.restype = wintypes.BOOL
        t = [wintypes.FILETIME() for _ in range(4)]
        if not k32.GetProcessTimes(k32.GetCurrentProcess(), *(ctypes.byref(x) for x in t)):
            return ""
        return str((t[0].dwHighDateTime << 32) | t[0].dwLowDateTime)
    except Exception:
        return ""


def _unmark_money_process(path):
    try:
        os.remove(path)
    except OSError:
        pass


def audit(event, **fields):
    """Append one JSON line to state/audit.jsonl. NEVER raises (see module
    docstring); returns True if the line was written."""
    try:
        os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
        record = {"ts": _now(), "event": event, **fields}
        with open(AUDIT_PATH, "a") as f:
            f.write(json.dumps(record, default=str) + "\n")
            f.flush()
            os.fsync(f.fileno())
        return True
    except Exception as e:
        logging.error(f"guard.audit failed for event '{event}': {e}")
        return False
