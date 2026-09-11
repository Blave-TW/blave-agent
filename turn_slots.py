"""
Machine-wide agent-turn slots (chat-sessions spec-c §3.4).

web_bridge and telegram_bridge are two processes with one budget: how many
agent_turn.py children this machine may run at once (the tier's cap, 1 on a
trial), and none at all while MemAvailable is under the floor. A slot is a
file in state/turn_slots/ created O_EXCL — the only cross-process mutex the
stdlib gives on both Linux and Windows without a daemon. The holder touches
its file every few seconds from a dedicated thread (keep_fresh); a slot nobody
has touched for STALE_S belongs to a dead bridge and is reclaimed. No pids: os.kill(pid, 0) TERMINATES the
process on Windows, and Win32_Process scans are slowest exactly when the box
is thrashing (see control/updater.turn_in_flight).

The cap itself arrives from the api on the command poll (`turn_limits`, see
openclaw/agent_command.py) and is kept in state/turn_limits.json by
command_listener; both bridges read that file at dispatch time, so a plan
change or the end of a trial takes effect on the next dispatch without a
restart. Missing file = DEFAULT_MAX_TURNS (a runtime ahead of the api).
"""
import json
import os
import sys
import threading
import time

import portfolio_reporter

BASE = os.environ.get("BLAVE_AGENT_BASE") or (
    r"C:\blave-agent" if os.name == "nt" else "/opt/blave-agent"
)
STATE_DIR = os.environ.get("BLAVE_AGENT_STATE", f"{BASE}/state")
LIMITS_PATH = f"{STATE_DIR}/turn_limits.json"
SLOTS_DIR = f"{STATE_DIR}/turn_slots"

DEFAULT_MAX_TURNS = 2
# Below this much MemAvailable no turn is added next to one already running (queued
# instead, retried by the dispatcher). ~1GB on a 4GB Starter; Windows reads
# ullAvailPhys through the same portfolio_reporter._memory().
LOW_MEM_MB = 1024
# A holder's keep_fresh thread touches its slot every TOUCH_INTERVAL_S. 90s is many
# missed touches; only a dead process (or an orphaned agent_turn, see CHANGELOG
# known limits) lets a slot go stale.
STALE_S = 90
TOUCH_INTERVAL_S = 4


def read_limits():
    try:
        with open(LIMITS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        n = int(data.get("max_turns"))
        if n < 1:
            raise ValueError(n)
        return {"max_turns": n, "trial": bool(data.get("trial"))}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"max_turns": DEFAULT_MAX_TURNS, "trial": False}


def write_limits(limits):
    """Persist what the api sent, only when it changed (called on every command
    poll, ~every 25s). Atomic: a bridge reads this file mid-write otherwise."""
    if not isinstance(limits, dict):
        return
    try:
        n = int(limits.get("max_turns"))
    except (TypeError, ValueError):
        return
    if n < 1:
        return
    new = {"max_turns": n, "trial": bool(limits.get("trial"))}
    if read_limits() == new and os.path.exists(LIMITS_PATH):
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = LIMITS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(new, f)
        os.replace(tmp, LIMITS_PATH)
        print(f"[turn_slots] limits → {new}", file=sys.stderr)
    except OSError as e:
        print(f"[turn_slots] cannot write {LIMITS_PATH}: {e}", file=sys.stderr)


def max_turns():
    return read_limits()["max_turns"]


def mem_low():
    """MemAvailable under the floor. Unknown (no /proc/meminfo, ctypes failure) is
    treated as fine — the gate is a courtesy to the box, not a safety interlock."""
    _total, avail, _swap = portfolio_reporter._memory()
    return avail is not None and avail < LOW_MEM_MB


def _slot_path(i):
    return os.path.join(SLOTS_DIR, f"slot-{i}")


def _is_stale(path):
    try:
        return time.time() - os.path.getmtime(path) > STALE_S
    except OSError:
        return False  # gone already — not ours to reclaim


def running_count():
    """Live slots (non-stale files), whichever process holds them."""
    try:
        names = os.listdir(SLOTS_DIR)
    except OSError:
        return 0
    return sum(1 for n in names
               if n.startswith("slot-") and not _is_stale(os.path.join(SLOTS_DIR, n)))


def acquire(session_id, surface):
    """Take a slot for one turn: the path to release later, or None when the cap is
    reached or memory is low. The memory gate only stops a turn from being ADDED to
    a box that already runs one — an idle box always starts its first turn, however
    little MemAvailable reports (Wei 2026-09-10; the alternative is a machine that
    never answers again)."""
    # Count, not just the slot scan below: after the cap shrinks (8→2 downgrade, or a
    # trial box before turn_limits.json lands) turns holding slot-2..7 are invisible to
    # a scan of slot-0..1, and the low numbers would keep being handed out.
    if running_count() >= max_turns():
        return None
    if mem_low() and running_count() > 0:
        return None
    try:
        os.makedirs(SLOTS_DIR, exist_ok=True)
    except OSError as e:
        print(f"[turn_slots] cannot create {SLOTS_DIR}: {e} — running unslotted",
              file=sys.stderr)
        return "unslotted"
    for i in range(max_turns()):
        path = _slot_path(i)
        if os.path.exists(path) and _is_stale(path):
            try:
                os.unlink(path)
            except OSError:
                pass
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        except OSError as e:
            print(f"[turn_slots] cannot create {path}: {e}", file=sys.stderr)
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "session_id": session_id, "surface": surface,
                       "since": time.time()}, f)
        return path
    return None


def touch(path):
    if not path or path == "unslotted":
        return
    try:
        os.utime(path, None)
    except OSError:
        pass


def keep_fresh(paths_fn, stop=None):
    """Touch every slot `paths_fn()` names, every TOUCH_INTERVAL_S, until `stop` is set.
    Its own thread on purpose: the turn's own loop blocks on network calls whose
    timeouts do not cover DNS, on proc.kill()/wait(), on the child itself — a slot
    must stay held for exactly as long as its holder has it registered, however long
    any of those take. Only a dead process stops touching."""
    stop = stop or threading.Event()
    while not stop.wait(TOUCH_INTERVAL_S):
        try:
            for path in paths_fn():
                touch(path)
        except Exception as e:  # a toucher that dies silently frees every slot in 90s
            try:
                print(f"[turn_slots] keep_fresh iteration failed: {e}", file=sys.stderr)
            except Exception:
                pass


def release(path):
    if not path or path == "unslotted":
        return
    try:
        os.unlink(path)
    except OSError:
        pass
