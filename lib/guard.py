"""
Trading guard: filesystem kill switch + append-only order audit log.

Why this exists: every safety rule in AGENTS.md (verify-then-report,
iteration brakes) runs through the model following instructions. This is the
one brake that does NOT: if the file state/HALT exists, no new-exposure order
leaves this machine, regardless of what the agent believes it is doing.
lib/order_*.py enforces it inside the transport layer, so every path that
uses the lib — strategies, reconciler, TWAP slices, ad-hoc scripts — is
covered without any caller opting in.

HALT semantics — blocks NEW EXPOSURE only:
- Blocked while halted: entry orders (anything that opens or adds to a
  position).
- Still allowed: reduce-only closes, protective SL/TP orders, cancels.
  A kill switch that traps a losing position is worse than none — flattening
  must always work under halt.
- The file's EXISTENCE is authoritative. Its JSON content ({ts, reason,
  source}) is attribution only — a malformed or hand-touched HALT file still
  halts (fail-closed).

Who trips it: the user (e.g. "全部停止" → agent runs trip_halt), a monitor
like manager/healthcheck.py on anomalies, or anyone creating state/HALT by
hand. Clearing requires an explicit user instruction — the agent must NEVER
clear a halt on its own initiative.

Audit log: state/audit.jsonl — one JSON line per order attempt, outcome,
halt denial, and halt change, fsynced per line so it survives a crash.
audit() never raises: a protective order must not fail because the audit
disk write did (errors are logged and swallowed — the one sanctioned
exception to the no-silent-failure rule, and only for the LOG write).
"""

import json
import logging
import os
import time
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
    """Raised instead of sending an entry order while state/HALT exists."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def halted():
    return _halt_flag or os.path.exists(HALT_PATH)


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


def check_restart_stop(intent, fields=None):
    """Every order-lib gate calls this before its HALT check: raises Halted for
    any order intent while the restart record exists. `fields` = the audit dict."""
    fields = fields or {}
    if intent in _RESTART_PASS or not restart_stopped():
        return
    if _close_all_granted and intent == "reduce":
        audit("order_allowed_close_all", **{**fields, "intent": intent})
        return
    audit("order_denied_restart", **{**fields, "intent": intent})
    raise Halted(
        f"the machine restarted and trading is stopped until the user presses "
        f"啟動下單 — {intent} order for {fields.get('symbol') or fields.get('instId') or fields.get('contract') or fields.get('currency_pair') or '?'} "
        f"refused before reaching the venue (closes included). Never remove "
        f"{RESTART_STOP_PATH} yourself.")


def halt_info():
    """Attribution dict from the HALT file, or None if not halted.
    Unreadable content still counts as halted — existence is what matters."""
    if not halted():
        return None
    try:
        with open(HALT_PATH) as f:
            return json.load(f)
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
    os.replace(tmp, HALT_PATH)
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
        with open(halt_path_for(strategy)) as f:
            return json.load(f)
    except Exception:
        return {"reason": "scoped HALT present but unreadable"}


def trip_halt_for(strategy, reason, source):
    """Set a strategy's OWN halt. Never touches the global HALT, so other
    strategies (and the user's kill switch) are unaffected."""
    os.makedirs(os.path.dirname(HALT_PATH), exist_ok=True)
    tmp = halt_path_for(strategy) + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"ts": _now(), "reason": reason, "source": source}, f)
    os.replace(tmp, halt_path_for(strategy))
    audit("halt_tripped", reason=reason, source=source, scope=strategy)


def clear_halt_for(strategy, source):
    """Remove a strategy's scoped halt. Only on explicit user instruction."""
    if os.path.exists(halt_path_for(strategy)):
        os.remove(halt_path_for(strategy))
    audit("halt_cleared", source=source, scope=strategy)


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
