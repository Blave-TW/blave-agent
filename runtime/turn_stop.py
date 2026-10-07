"""
Stop a running agent turn from outside (user pressed Stop).

The signal is a per-turn flag file whose path the launcher (web_bridge, the desktop
shell) puts in BLAVE_TURN_INTERRUPT_FILE; the launcher creates the file to stop the
turn. Env, not argv: a launcher newer than the runtime must not make argparse exit 2,
and a runtime that doesn't know the variable just ignores it.

The previous only channel — /report's `interrupt: true` piggyback — reaches the turn
only when it POSTs a chunk, and run_turn only checked it at message boundaries: a
long backtest or a silent think kept running to the end. The watcher here polls
the flag (and sink.interrupted, so the piggyback path gets the same treatment), kills
the turn's process tree so the tool dies with it, and cancels the turn task if the
SDK stream has not ended on its own shortly after.

Money-moving processes are never killed (MONEY_ARGV / money_pids below): they finish
on their own, exactly as they would have before Stop existed. With Claude that is
free — its Bash tools write to a file, not to the CLI, so they outlive the CLI. With
Codex the tools write into pipes Codex reads; killing Codex would make the script's
next print raise BrokenPipeError. So under Codex the engine is held (not killed, its
stdout still drained by codex_engine) until the money process has exited, for at most
HOLD_MAX_S.
"""
import asyncio
import os
import re
import signal
import subprocess
import sys

ENV = "BLAVE_TURN_INTERRUPT_FILE"
POLL_S = 0.25
# The CLI dying normally ends the SDK stream within a tick; cancel only if it hasn't.
CANCEL_AFTER_S = 1.0

# Processes a Stop must let finish. The one real failure: manager/close_symbol.py
# cancels the stop-loss / take-profit, then closes — a SIGKILL in between leaves the
# position open and unprotected, with no warning printed; after the fill but before
# the ledger write, the book disagrees with the exchange. The same shape exists in
# stop_strategy (closes via close_symbol), flatten / close_all, seed_ledger, the
# reconciler, the workspace updater (half-replaced files), venue binding (.env) and
# any direct lib/order_* / lib/execute / lib/venue (.env) / lib/portfolio (ledger) call.
# Matched on the whole command line; what is kept around a match is split_tree's job.
MONEY_ARGV = re.compile(
    r"close_symbol|stop_strategy|manager[./]flatten|close_all|update_workspace|seed_ledger|reconciler\.py"
    r"|capital_worker|president_worker|lib[./](?:order_|execute|venue|portfolio)"
    r"|from\s+lib\s+import\s[^;\n]*\b(?:order_\w+|execute|venue|portfolio)\b"
    r"|\border_(?:binance|bingx|bybit|okx|gateio|paper|capital|sinopac|president)\b")
# Hand-written scripts (`python tmp/close.py`) don't show it in argv: every lib/order_*
# marks its process here at import (lib/guard.mark_money_process), until it exits.
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
MONEY_PID_DIR = os.path.join(WORKSPACE, "state", "execution", "money_pids")

# How long a Stop keeps Codex alive for a money script. Past this, the script is
# something long-lived (a foreground reconciler, a TWAP, a monitor loop) and holding
# on would leave the desktop at "stopping" forever: Codex is killed and the reply says
# the script may not have finished.
HOLD_MAX_S = 120

# Set while this turn has a watcher: codex_engine then never breaks or kills Codex on
# its own after a Stop — it keeps draining (without forwarding) and turn_stop decides.
# Breaking in the gap between "interrupted" and the first sweep cut a money script's
# pipe (re-audit R1).
_armed = False


def armed():
    return _armed


def descendants(pairs, root):
    """pids under `root` in a [(pid, ppid)] table, parents before children."""
    kids = {}
    for pid, ppid in pairs:
        if pid != ppid:
            kids.setdefault(ppid, []).append(pid)
    out, todo, seen = [], [root], {root}
    while todo:
        for child in kids.get(todo.pop(0), ()):
            if child not in seen:
                seen.add(child)
                out.append(child)
                todo.append(child)
    return out


def _posix_table():
    """[(pid, ppid)] and {pid: command line}."""
    out = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "command="],
                         capture_output=True, text=True, timeout=5,
                         stdin=subprocess.DEVNULL).stdout
    pairs, cmds = [], {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            pid = int(parts[0])
            pairs.append((pid, int(parts[1])))
            cmds[pid] = parts[2] if len(parts) == 3 else ""
    return pairs, cmds


def _money_pids():
    """pids with a live marker; markers of dead processes are removed on the way."""
    out = set()
    try:
        names = os.listdir(MONEY_PID_DIR)
    except OSError:
        return out
    for name in names:
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            os.kill(pid, 0)
            out.add(pid)
        except ProcessLookupError:
            try:
                os.remove(os.path.join(MONEY_PID_DIR, name))
            except OSError:
                pass
        except OSError:
            out.add(pid)  # alive, just not ours to signal
    return out


def money_label(cmd):
    m = MONEY_ARGV.search(cmd or "")
    if not m:
        return None
    g = m.group(0)
    return ("lib/" + g[4:]).rstrip("_") if g[:4] in ("lib/", "lib.") else g


def split_tree(tree, pairs, is_money, hold_engine, sid_of=None, own_sid=None):
    """(kill, keep) inside `tree` (the in-scope pids, parents first). Kept: a money
    process, everything under it, and its whole session unless that is the turn's own
    — Claude runs each Bash tool call in a session of its own, so `python3 x.py | tail`
    keeps the `tail` its stdout goes to (killing it = BrokenPipeError mid-close). With
    hold_engine (Codex), the whole tree while any money process runs."""
    if hold_engine and any(is_money(p) for p in tree):
        # Codex pipes every tool through itself and a `| tail` may sit anywhere in its tree:
        # while a money process runs, nothing is killed (the hold is capped by HOLD_MAX_S)
        return [], set(tree)
    parent = dict(pairs)
    in_tree = set(tree)
    sid_of = sid_of or (lambda p: None)
    money_sids = {sid_of(p) for p in tree if is_money(p)} - {None, own_sid}
    keep = set()
    for pid in tree:  # parents come first, so a kept parent is seen before its children
        if pid in keep:
            continue
        if parent.get(pid) in keep or is_money(pid) or sid_of(pid) in money_sids:
            keep.add(pid)
    if hold_engine:
        for pid in list(keep):
            up = parent.get(pid)
            while up in in_tree and up not in keep:
                keep.add(up)
                up = parent.get(up)
    return [pid for pid in tree if pid not in keep], keep


def _sid(pid):
    try:
        return os.getsid(pid)
    except OSError:
        return None


def posix_targets(pairs, root, sid_of):
    """What a Stop may kill under `root`. The CLI runs each Bash tool in a new session
    (setsid; seen on Claude Code 2.1.x), so "same session as the turn" alone would miss
    the tool itself. Rule: follow children in the parent's session, and a new-session
    child only when its parent is in the turn's own session (the CLI's tool shells).
    A new session opened further down is a deliberate detach from inside a tool and
    must outlive the turn exactly as it would at a normal turn end. (This is not what
    protects money scripts — the agent runs those in the tool shell's own session;
    see MONEY_ARGV.)"""
    kids = {}
    for pid, ppid in pairs:
        if pid != ppid:
            kids.setdefault(ppid, []).append(pid)
    own = sid_of(root)
    out, todo = [], [root]
    while todo:
        parent = todo.pop(0)
        psid = sid_of(parent)
        for child in kids.get(parent, ()):
            csid = sid_of(child)
            if csid is None or child in out:
                continue
            if csid == psid or (csid == child and psid == own):
                out.append(child)
                todo.append(child)
    return out


def _windows_pairs():
    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    for fn in (k32.Process32FirstW, k32.Process32NextW):
        fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
        fn.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snap in (None, wintypes.HANDLE(-1).value):
        return []
    pairs = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            pairs.append((entry.th32ProcessID, entry.th32ParentProcessID))
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return pairs


def kill_tree(root=None, hold_engine=False):
    """Kill the turn's engine and tools (never `root` itself), sparing money processes.
    Returns (killed pids, labels of the money processes left running).

    Windows (not yet verified on a real box): only the engine — `root`'s direct
    children — is killed, without /T. The tools are left to finish: a Toolhelp ppid can
    be stale (pid reuse), and /T could reach a flatten that had detached through
    powershell. Follow-up: trust a ppid only when the child was created after the
    parent (GetProcessTimes) and kill pid by pid, then extend the money rule here."""
    root = os.getpid() if root is None else root
    try:
        if os.name == "nt":
            direct = [pid for pid, ppid in _windows_pairs() if ppid == root and pid != root]
            for pid in direct:
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True,
                               timeout=10, stdin=subprocess.DEVNULL,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return direct, []
        pairs, cmds = _posix_table()
        tree = posix_targets(pairs, root, _sid)
        marked = _money_pids()
        kill, keep = split_tree(tree, pairs, lambda p: p in marked or bool(money_label(cmds.get(p))),
                                hold_engine, _sid, _sid(root))
        for pid in kill:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        labels = sorted({money_label(cmds.get(p)) or ("order script" if p in marked else None)
                         for p in keep} - {None})
        return kill, labels
    except Exception as e:  # a failed kill must not take the turn's own wrap-up with it
        print(f"[turn_stop] kill_tree failed: {e}", file=sys.stderr)
        return [], []


def requested(path):
    return bool(path) and os.path.exists(path)


async def _watch(sink, task, path, hold_engine):
    while not (getattr(sink, "interrupted", False) or requested(path)):
        await asyncio.sleep(POLL_S)
    sink.interrupted = True
    left = getattr(sink, "stop_left_running", None)
    if left is None:
        left = sink.stop_left_running = set()
    print("[turn_stop] stop requested — killing the turn's tools", file=sys.stderr)
    loop = asyncio.get_running_loop()
    waited, beat, held = 0.0, 0.0, 0.0
    # Keep sweeping until run_turn's finally cancels us: a tool the CLI starts between
    # two sweeps (or a CLI that was still spawning when Stop landed) is caught next tick.
    while True:
        hold = hold_engine and held < HOLD_MAX_S
        _, labels = await loop.run_in_executor(None, kill_tree, None, hold)
        left.update(labels)
        if hold and labels:
            held += POLL_S
            waited = 0.0  # the cancel fallback counts from the end of the hold
            beat += POLL_S
            if beat >= 1.0:  # the desktop shell's fallback kill waits for silence
                beat = 0.0
                sink._send({"type": "ping"})
            if held >= HOLD_MAX_S:
                sink.stop_gave_up = sorted(labels)
                print(f"[turn_stop] {labels} still running after {HOLD_MAX_S}s — no longer "
                      "holding the engine", file=sys.stderr)
        elif waited >= CANCEL_AFTER_S and not task.done():
            task.cancel()
            waited = float("-inf")  # once
        await asyncio.sleep(POLL_S)
        waited += POLL_S


def final_sweep(sink):
    """run_turn's finally, on a stopped turn: one last sweep before the watcher goes. The
    /report piggyback ends the Claude loop at a block boundary, possibly before the
    watcher's first sweep — without this the CLI and its tools outlive the stop. (The
    SDK's aclose() does not end them: probed on SDK 0.2.144, the CLI and a running Bash
    tool were both still alive after it.)"""
    if not getattr(sink, "interrupted", False):
        return
    _, labels = kill_tree()
    left = getattr(sink, "stop_left_running", None)
    if left is None:
        left = sink.stop_left_running = set()
    left.update(labels)


def _disarm(_task):
    global _armed
    _armed = False


def start(sink, hold_engine=False):
    """Arm the watcher for this turn; returns the task (cancel it when the turn ends)
    or None when the launcher gave no flag path. The variable is removed from our
    environment so the tools the agent runs don't inherit it. hold_engine: the engine
    pipes its tools' output (Codex) — keep it alive while a money process runs."""
    global _armed
    path = os.environ.pop(ENV, None)
    if not path:
        return None
    _armed = True
    watcher = asyncio.ensure_future(_watch(sink, asyncio.current_task(), path, hold_engine))
    watcher.add_done_callback(_disarm)
    return watcher
