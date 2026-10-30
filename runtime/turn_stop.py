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
import time

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
    r"close_symbol|stop_strategy|manager[./\\]flatten|close_all|update_workspace|seed_ledger|reconciler\.py"
    r"|capital_worker|president_worker|lib[./\\](?:order_|execute|venue|portfolio)"
    r"|from\s+lib\s+import\s[^;\n]*\b(?:order_\w+|execute|venue|portfolio)\b"
    r"|\border_(?:binance|bingx|bybit|okx|gateio|paper|capital|sinopac|president|stockcoin|bitget)\b",
    re.I)  # Windows: PowerShell paths use \, and the file system ignores case
# Hand-written scripts (`python tmp/close.py`) don't show it in argv: every lib/order_*
# marks its process here at import (lib/guard.mark_money_process), until it exits.
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
MONEY_PID_DIR = os.path.join(WORKSPACE, "state", "execution", "money_pids")

# How long a Stop keeps Codex alive for a money script. Past this, the script is
# something long-lived (a foreground reconciler, a TWAP, a monitor loop) and holding
# on would leave the desktop at "stopping" forever: Codex is killed and the reply says
# the script may not have finished.
HOLD_MAX_S = 120

_NT = os.name == "nt"

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


def _marker_pids():
    try:
        return {int(n) for n in os.listdir(MONEY_PID_DIR) if n.isdigit()}
    except OSError:
        return set()


def _marker_stamps():
    """{pid: creation time the process wrote into its marker (lib/guard, Windows), or None for
    a marker without one (POSIX, older lib)}."""
    out = {}
    for pid in _marker_pids():
        try:
            with open(os.path.join(MONEY_PID_DIR, str(pid))) as f:
                text = f.read().strip()
            out[pid] = int(text) if text.isdigit() else None
        except (OSError, ValueError):
            out[pid] = None
    return out


def _money_pids():
    """pids with a live marker; markers of dead processes are removed on the way. POSIX only:
    on Windows os.kill(pid, 0) is TerminateProcess — _clear_dead_markers checks them against
    the Toolhelp table instead."""
    out = set()
    for pid in _marker_pids():
        name = str(pid)
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
    g = m.group(0).lower().replace("\\", "/")
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


# The label a Stop reports when it cannot see the process table: under Codex, a money script
# may be in there, so the engine is held (to HOLD_MAX_S) exactly as if one were. The reply
# says it could not tell (agent_turn._stop_note), not that one is running.
UNSEEN = "unconfirmed"


DENIED = "denied"


def _k32():
    import ctypes
    return ctypes.WinDLL("kernel32", use_last_error=True)


def _nt_open(pid):
    """A handle that may terminate and query `pid`, or None. Held from the creation-time check
    to TerminateProcess, so the process killed is the one checked (no pid reuse in between)."""
    import ctypes
    k32 = _k32()
    k32.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_uint]
    k32.OpenProcess.restype = ctypes.c_void_p
    return k32.OpenProcess(0x1001, False, pid) or None  # TERMINATE | QUERY_LIMITED_INFORMATION


def _nt_open_query(pid):
    """For a pid _nt_open could not get: a query-only handle, DENIED when the process is there
    but not ours to open, None when it is gone."""
    import ctypes
    k32 = _k32()
    k32.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_uint]
    k32.OpenProcess.restype = ctypes.c_void_p
    h = k32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if h:
        return h
    return DENIED if ctypes.get_last_error() == 5 else None  # ERROR_ACCESS_DENIED


def _nt_ppid(handle):
    """Parent pid as recorded in the process behind `handle` (ProcessBasicInformation), or None.
    Read through the handle, it belongs to the process that is open — not to whoever held the
    pid when the table was taken."""
    import ctypes

    class PROCESS_BASIC_INFORMATION(ctypes.Structure):
        _fields_ = [("ExitStatus", ctypes.c_long), ("PebBaseAddress", ctypes.c_void_p),
                    ("AffinityMask", ctypes.c_size_t), ("BasePriority", ctypes.c_long),
                    ("UniqueProcessId", ctypes.c_size_t),
                    ("InheritedFromUniqueProcessId", ctypes.c_size_t)]

    q = ctypes.WinDLL("ntdll").NtQueryInformationProcess
    q.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong,
                  ctypes.POINTER(ctypes.c_ulong)]
    q.restype = ctypes.c_long
    pbi = PROCESS_BASIC_INFORMATION()
    if q(handle, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), None) < 0:
        return None
    return int(pbi.InheritedFromUniqueProcessId)


def _nt_image(handle):
    """Lower-case executable name (conhost.exe), or "" when it cannot be read."""
    import ctypes
    from ctypes import wintypes
    k32 = _k32()
    k32.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.LPWSTR,
                                               ctypes.POINTER(wintypes.DWORD)]
    k32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    buf, size = ctypes.create_unicode_buffer(1024), wintypes.DWORD(1024)
    if not k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
        return ""
    return buf.value.replace("/", "\\").rsplit("\\", 1)[-1].lower()


def _nt_created(handle):
    """Creation time (FILETIME ticks) of the process behind `handle`, or None."""
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k32.GetProcessTimes.restype = wintypes.BOOL
    t = [wintypes.FILETIME() for _ in range(4)]
    if not k32.GetProcessTimes(handle, *(ctypes.byref(x) for x in t)):
        return None
    return (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime


def _nt_cmdline(handle):
    """Command line of the process behind `handle` (ProcessCommandLineInformation, Windows 8.1+;
    no process is spawned), "" once it has exited (a short-lived step a shell still holds a
    handle to: nothing left to protect), None when a live one cannot be read."""
    import ctypes

    class UNICODE_STRING(ctypes.Structure):
        _fields_ = [("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort),
                    ("Buffer", ctypes.c_void_p)]

    q = ctypes.WinDLL("ntdll").NtQueryInformationProcess
    q.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong,
                  ctypes.POINTER(ctypes.c_ulong)]
    q.restype = ctypes.c_long
    need = ctypes.c_ulong(0)
    q(handle, 60, None, 0, ctypes.byref(need))
    buf = ctypes.create_string_buffer(max(need.value, 1))
    if need.value < ctypes.sizeof(UNICODE_STRING) or q(handle, 60, buf, need.value, ctypes.byref(need)) < 0:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        code = ctypes.c_ulong(0)
        exited = k32.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value != 259  # STILL_ACTIVE
        return "" if exited else None
    us = UNICODE_STRING.from_buffer(buf)
    return ctypes.wstring_at(us.Buffer, us.Length // 2) if us.Buffer and us.Length else ""


def _nt_terminate(handle):
    import ctypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    return bool(k32.TerminateProcess(handle, 1))


def _nt_close(handle):
    import ctypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CloseHandle.argtypes = [ctypes.c_void_p]
    k32.CloseHandle(handle)


def _nt_pairs():
    """Toolhelp table, or [] when it cannot be read."""
    try:
        return _windows_pairs()
    except Exception as e:
        print(f"[turn_stop] process table unreadable: {e}", file=sys.stderr)
        return []


def _clear_dead_markers(pairs, markers):
    """Windows has no os.kill(pid, 0) to tell a dead marker (it is TerminateProcess there): a
    marker whose pid is not in a readable Toolhelp table is left by a process that is gone.
    `markers` is listed BEFORE the table is taken: one written after the table by a process
    the table does not show yet must not be removed (that process never marks itself again)."""
    live = {pid for pid, _ in pairs}
    for pid in markers - live:
        try:
            os.remove(os.path.join(MONEY_PID_DIR, str(pid)))
        except OSError:
            pass


def _live_marks(info):
    """Markers that count: no creation time recorded (POSIX, older lib), or one that matches the
    process now holding the pid. A marker left by a hard-killed process whose pid went to this
    turn's engine would otherwise keep the whole turn alive."""
    out = set()
    for pid, stamp in _marker_stamps().items():
        now = info.get(pid, (None,))[0]
        if stamp is None or now is None or now == stamp:
            out.add(pid)
    return out


def _nt_probe(pairs, root, handles, info, strict):
    """Open root and every pid listed under it that is not open yet: handles[pid], and
    info[pid] = (creation time, command line, killable). Gone, or its pid reused since the
    table (the parent read through the handle differs), stays out of info. strict: a parent
    that cannot be read through the handle stays out too — on the second look there is no
    later table to catch a reuse, the next sweep takes it. There but not ours to open:
    (None, None, False), which nt_plan counts as unconfirmed. conhost.exe is never killed
    (the console the engine and a kept money tool share)."""
    listed = dict(pairs)
    for pid in [root] + descendants(pairs, root):
        if pid in info:
            continue
        h = _nt_open(pid)
        killable = bool(h)
        if not h:
            h = _nt_open_query(pid)
            if h == DENIED:
                info[pid] = (None, None, False)
                continue
            if not h:
                continue
        handles[pid] = h
        if pid == root:
            info[pid] = (_nt_created(h), "", False)
            continue
        ppid = _nt_ppid(h)
        if ppid != listed.get(pid) and (strict or ppid is not None):
            del handles[pid]  # the second look may open this pid again
            _nt_close(h)
            continue
        if _nt_image(h) == "conhost.exe":
            info[pid] = (_nt_created(h), "", False)
            continue
        info[pid] = (_nt_created(h), _nt_cmdline(h), killable)


def _nt_kill(root, hold_engine):
    markers = _marker_pids()
    pairs = _nt_pairs()
    if not pairs:
        return [], ([UNSEEN] if hold_engine else [])
    _clear_dead_markers(pairs, markers)
    handles, info = {}, {}
    try:
        _nt_probe(pairs, root, handles, info, False)
        kill, labels = nt_plan(pairs, root, _live_marks(info), hold_engine, info)
        if kill:
            # With the handles open, look again: a script that imported lib/order_* after the
            # snapshot has marked itself, and a child started meanwhile would be orphaned (never
            # reparented, so no later sweep reaches it) once its parent is terminated.
            again = _nt_pairs()
            if not again:
                return [], ([UNSEEN] if hold_engine else labels)
            _nt_probe(again, root, handles, info, True)
            kill, labels = nt_plan(again, root, _live_marks(info), hold_engine, info)
        return [pid for pid in kill if _nt_terminate(handles[pid])], labels
    finally:
        for h in handles.values():
            _nt_close(h)


def nt_plan(pairs, root, marked, hold_engine, info=None):
    """(kill, labels) on Windows: the whole tree under `root`, pid by pid, but money processes.
    info = {pid: (creation time, command line or None if unreadable, killable)} for every pid
    that could be looked at (None: every pid in `pairs`, killable, no command lines). A Toolhelp
    ppid can be stale — the parent died and its pid went to a newer process — so a link is
    trusted only when the child was not created before its parent; an untrusted pid is not
    killed, nor anything under it. Money = a lib/guard marker or MONEY_ARGV on the command line
    (not for the engine, `root`'s direct children: Claude's argv names president_worker); an
    unreadable command line, or a live process directly under a trusted one that cannot be
    opened at all, counts as money (UNSEEN). Kept, as split_tree does on POSIX: a money
    process, everything under it, and its whole tool call — the subtree of the engine's child
    it sits in, Windows having no sessions — so `python close.py | tail` keeps its tail. With
    hold_engine (Codex pipes its tools' output), nothing is killed while a money process sits
    under `root`; there a marker counts even through an untrusted link (a stale ppid can only
    add a process to the hold, which _watch caps at HOLD_MAX_S)."""
    if info is None:
        info = {pid: (0, "", True) for pair in pairs for pid in pair}
    kids = {}
    for pid, ppid in pairs:
        if pid != ppid:
            kids.setdefault(ppid, []).append(pid)
    engines = set(kids.get(root, ()))
    tree, parent, unit = [], {}, {}
    todo = [root]
    while todo:
        up = todo.pop(0)
        up_t = info[up][0] if up in info else None
        if up_t is None:
            continue
        for child in kids.get(up, ()):
            if child == root or child in parent or child not in info:
                continue
            t = info[child][0]
            if t is not None and t < up_t:
                continue
            parent[child] = up
            unit[child] = child if up == root or up in engines else unit[up]
            tree.append(child)
            if t is not None:  # a pid that could not be opened: nothing under it is trusted
                todo.append(child)

    def label(pid):
        if pid in marked:
            return "order script"
        if pid in engines:
            return None
        cmd = info[pid][1]
        return UNSEEN if cmd is None else money_label(cmd)

    def killable(pid):
        # no creation time = its link to the parent was never checked
        return info[pid][2] and info[pid][0] is not None

    money = {pid: label(pid) for pid in tree}
    if hold_engine:
        labels = {m for m in money.values() if m}
        if marked & set(descendants(pairs, root)):
            labels.add("order script")
        if labels:
            return [], sorted(labels)
        return [pid for pid in tree if killable(pid)], []
    money_units = {unit[pid] for pid in tree if money[pid] and pid not in engines}
    keep = set()
    for pid in tree:
        if parent[pid] in keep or money[pid] or unit[pid] in money_units:
            keep.add(pid)
    return ([pid for pid in tree if pid not in keep and killable(pid)],
            sorted({money[p] for p in keep} - {None}))


def kill_tree(root=None, hold_engine=False):
    """Kill the turn's engine and tools (never `root` itself), sparing money processes.
    Returns (killed pids, labels of the money processes left running).

    Windows: see nt_plan and _nt_kill. Under Codex an unreadable process table holds the
    engine, never frees it.

    "The engine" is every direct child of `root`: agent_turn spawns nothing else in-process
    but the engine's own short probes (codex --version, ps) — pinned by
    tests/check_turn_stop.py, because a money script started there would escape MONEY_ARGV."""
    root = os.getpid() if root is None else root
    try:
        if _NT:
            return _nt_kill(root, hold_engine)
        pairs, cmds = _posix_table()
        if not pairs:  # ps gave nothing: it failed, the table is never really empty
            return [], ([UNSEEN] if hold_engine else [])
        tree = posix_targets(pairs, root, _sid)
        marked = _money_pids()
        # The engine's own argv is its configuration, not a tool's command: Claude's carries
        # --disallowedTools Edit(/lib/president_worker.py)…, which MONEY_ARGV matched — the CLI
        # and every tool under it were kept, so Stop killed nothing. Markers still count.
        engines = {pid for pid, ppid in pairs if ppid == root}
        kill, keep = split_tree(tree, pairs, lambda p: p in marked or (
            p not in engines and bool(money_label(cmds.get(p)))), hold_engine, _sid, _sid(root))
        for pid in kill:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        labels = sorted({(None if p in engines else money_label(cmds.get(p)))
                         or ("order script" if p in marked else None) for p in keep} - {None})
        return kill, labels
    except Exception as e:  # a failed kill must not take the turn's own wrap-up with it
        print(f"[turn_stop] kill_tree failed: {e}", file=sys.stderr)
        return [], ([UNSEEN] if hold_engine else [])


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
    waited, held_since, last_ping = 0.0, None, time.monotonic()

    def ping_due():
        # the desktop shell kills agent_turn after 5 s of silence: ping by the clock, also while
        # a sweep is slow (ps can take up to its 5 s timeout)
        nonlocal last_ping
        if time.monotonic() - last_ping >= 1.0:
            last_ping = time.monotonic()
            sink._send({"type": "ping"})

    # Keep sweeping until run_turn's finally cancels us: a tool the CLI starts between
    # two sweeps (or a CLI that was still spawning when Stop landed) is caught next tick.
    held_labels, gave_up = [], False
    while True:
        if held_since is not None and not gave_up and time.monotonic() - held_since >= HOLD_MAX_S:
            gave_up = True
            sink.stop_gave_up = sorted(held_labels)
            print(f"[turn_stop] {held_labels} still running after {HOLD_MAX_S}s — no longer "
                  "holding the engine", file=sys.stderr)
        hold = hold_engine and not gave_up
        sweep = loop.run_in_executor(None, kill_tree, None, hold)
        # wake when the next ping is due, not on a fixed 1 s tick: a tick that lands a few ms short of the
        # 1 s threshold would push that ping to the next tick (~2 s gaps against the shell's 5 s silence limit)
        while hold and not (await asyncio.wait({sweep}, timeout=max(0.05, 1.0 - (time.monotonic() - last_ping))))[0]:
            ping_due()
        _, labels = await sweep
        left.update(labels)
        if hold and labels:
            if held_since is None:
                held_since = time.monotonic()
            held_labels = labels
            waited = 0.0  # the cancel fallback counts from the end of the hold
            ping_due()
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
