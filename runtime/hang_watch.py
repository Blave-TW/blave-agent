"""A reconciler that stopped making progress is killed; its supervisor starts the next one.

Shared by the two watchers: runtime/local_daemon.ReconcilerSupervisor.tick (desktop, every second)
and command_listener._hang_watch_loop (cloud, every HANG_WATCH_TICK_S). Each caller decides WHO may
be killed (its own child; the pid the cloud service runs) and holds its own lock against stop /
unbind / start; this module only measures the stall, keeps the records and runs the kill it is
handed. It never starts anything: the respawn is the supervisor's (tick's RESTART_DELAY_S, the
start_reconciler.sh / .ps1 loop under systemd / NSSM).

Progress = state/heartbeat/reconciler_progress (manager/reconciler.py): written once at startup
with the process's pid — only a reconciler that marks every order leg writes it, so an older one
is never watched — then its mtime moves at every loop top and around every order leg, position
read and venue lookup. Stalled = now − max(stamp mtime, when this watcher first saw that pid,
when this watcher last saw the wall clock jump), so a fresh process, a leftover stamp and a
machine back from sleep each get the full threshold.

Import-safe, stdlib only (the cloud updater imports every runtime module as a health check)."""
import json
import os
import time

import atomic_file

HANG_STALL_S = 240       # two worst-case order legs (~120 s each); under the platform's 300 s dead mark
CLOCK_JUMP_S = 30        # two checks further apart than this = the watcher was asleep (or the clock moved)
STREAK_WINDOW_S = 3600
HALT_AT = 3              # the 3rd kill inside the window halts first; past it nothing is killed
RECORD_FRESH_S = 900     # = manager/reconciler.HANG_RECORD_FRESH_S, start_reconciler.sh / .ps1
HALT_RETRY_S = 60        # a HALT that could not be written (full disk) is tried again this much later
HALT_SOURCE = "hang_watch"  # not in api agent_events._HALT_AUTO_SOURCES: reconciler_hang_halted is the P1
HALT_REASON = "reconciler hung 3 times within 1h — paused; press 啟動下單 to resume"

PROGRESS = os.path.join("state", "heartbeat", "reconciler_progress")
RECORD = os.path.join("state", "execution", "hang_kill.json")
KILLS = os.path.join("state", "execution", "hang_kills.json")
INFLIGHT_DIR = os.path.join("state", "execution", "inflight")


def _pid(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None


def stamp_doc(ws):
    """The stamp's content ({pid, ppid, at, v}), None when unreadable."""
    try:
        doc = atomic_file.load_json(os.path.join(ws, PROGRESS), encoding="utf-8")
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def stamp(ws):
    """(pid, mtime, ppid|None) of the progress stamp, None when absent, unreadable or not a pid."""
    path = os.path.join(ws, PROGRESS)
    try:
        mtime = os.path.getmtime(path)
        doc = atomic_file.load_json(path, encoding="utf-8")
        pid, ppid = _pid(doc.get("pid")), _pid(doc.get("ppid"))
    except (OSError, ValueError, AttributeError):
        return None
    return (pid, mtime, ppid) if pid else None


class Watch:
    """One per watcher; the clock is injectable for tests."""

    def __init__(self, ws, clock=time.time):
        self.ws, self.clock = ws, clock
        self._key = self._first_seen = self._last_check = self._gap_end = None
        self.target = None    # the stamp's pid after a matching stall()
        self._done = {}       # key -> until when it is left alone (handled once, or skipped)

    def handled(self, key, outcome):
        """After act(): a killed (or left-alone) process is never counted again — the kill is
        asynchronous (TerminateProcess, a process stuck in kernel I/O), and counting the same hang
        on every check until it dies would reach the 3rd-kill HALT on one real hang. A HALT that
        could not be written is tried again after HALT_RETRY_S; the rest after STREAK_WINDOW_S."""
        self._done[key] = self.clock() + (HALT_RETRY_S if outcome == "halt_failed" else STREAK_WINDOW_S)

    def left_alone(self, key):
        until = self._done.get(key)
        if until is None:
            return False
        if self.clock() >= until:
            del self._done[key]
            return False
        return True

    def stall(self, pid, via_parent=False, key=None):
        """Seconds without progress for `pid`, None when its stamp is not that pid's. via_parent
        (Windows desktop: `pid` is the venv launcher) also accepts a stamp whose ppid is `pid`;
        `self.target` is then the reconciler's own pid, the one to kill. `key` identifies the
        process watched (the desktop's Popen object; default the pid): a new one starts its own
        threshold even when the OS hands out the same pid again."""
        now = self.clock()
        if self._last_check is not None and (now - self._last_check > CLOCK_JUMP_S or now < self._last_check):
            self._gap_end = now
        self._last_check = now
        key = pid if key is None else key
        if key != self._key:
            self._key, self._first_seen = key, now
        st = stamp(self.ws)
        self.target = None
        if st is None or not (st[0] == pid or (via_parent and st[2] == pid)):
            return None
        self.target = st[0]
        return max(0.0, now - max(st[1], self._first_seen, self._gap_end or 0.0))


def recent_kills(ws, now):
    try:
        ats = atomic_file.load_json(os.path.join(ws, KILLS), encoding="utf-8").get("at")
    except (OSError, ValueError, AttributeError):
        return []
    return [a for a in ats if isinstance(a, (int, float)) and 0 <= now - a <= STREAK_WINDOW_S] \
        if isinstance(ats, list) else []


def _write(ws, rel, doc):
    path = os.path.join(ws, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with atomic_file.replacing(path, encoding="utf-8") as f:
        json.dump(doc, f)


def _inflight_keys(ws):
    try:
        return sorted(n[:-5] for n in os.listdir(os.path.join(ws, INFLIGHT_DIR)) if n.endswith(".json"))
    except OSError:
        return []


def act(ws, pid, kill, trip_halt, log, now=None, audit=None):
    """The stall is confirmed and the caller holds its lock: kill `pid` (or not). Returns
    "kill", "halt" (HALT tripped, then killed), "skip" (4th and later in the window),
    "halt_failed" (HALT not written) or "kill_failed" (the kill raised; not counted) — the last
    three leave it hung and the platform's dead mark takes over.
    trip_halt() returns True when it tripped the HALT, False when one was already on (the
    user's own pause keeps its source) — only the first makes the record say halt, so the next
    reconciler does not announce an automatic pause that is the user's.
    The record is written before the kill: the next reconciler sends the one notice from it."""
    now = time.time() if now is None else now
    kills = recent_kills(ws, now)
    if len(kills) >= HALT_AT:
        log(f"reconciler (pid {pid}) hung again — {len(kills)} kills within the hour, left alone")
        return "skip"
    third = len(kills) == HALT_AT - 1
    halt = False
    if third:
        try:
            halt = trip_halt() is not False
        except Exception as e:
            log(f"reconciler (pid {pid}) hung a 3rd time and HALT could not be written "
                f"({type(e).__name__}: {e}) — not killed")
            return "halt_failed"
    try:
        _write(ws, RECORD, {"pid": pid, "at": now, "inflight": _inflight_keys(ws), "halt": halt})
        _write(ws, KILLS, {"at": kills + [now]})
    except OSError as e:
        log(f"hang record not written ({type(e).__name__}: {e}) — killing anyway")
    try:
        kill(pid)
    except Exception as e:
        # not killed = not counted, and no record for a next reconciler that is not coming
        log(f"reconciler (pid {pid}) hung but could not be killed ({type(e).__name__}: {e}) — left alone")
        if halt and audit:
            # the HALT is on (source hang_watch, P3) but no reconciler_hang_halted will follow
            audit("hang_kill_failed", pid=pid, halt=True, error=f"{type(e).__name__}: {e}"[:200])
        for rel, doc in ((KILLS, {"at": kills}),):
            try:
                _write(ws, rel, doc)
            except OSError:
                pass
        try:
            os.remove(os.path.join(ws, RECORD))
        except OSError:
            pass
        return "kill_failed"
    log(f"reconciler (pid {pid}) made no progress for {HANG_STALL_S}s+ — killed"
        + (" after tripping HALT (3rd hang within the hour)" if halt else
           " (3rd hang within the hour; a pause was already on)" if third else ""))
    return "halt" if third else "kill"
