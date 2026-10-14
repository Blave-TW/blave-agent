"""Is a reconciler process there? Stdlib only, shared by command_listener and
portfolio_reporter (the reporter must not import command_listener:
tests/check_sched_bash_guard.py ③ counts every importer of it as able to place
orders or change keys). Reads /proc, the Windows process list and two lock
files; never starts, stops or signals anything."""
import os
import platform
import re
import subprocess
import time

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
WORKSPACE_STATE = os.path.join(WORKSPACE, "state")
RECONCILER_UNIT = "blave-agent-reconciler.service"  # = command_listener.RECONCILER_UNIT
# a reconciler touches its heartbeat every 5 s; past this it is taken for dead.
# The one definition: portfolio_reporter imports it from here.
HEARTBEAT_STALE_S = 300
# the desktop daemon's reconciler supervisor (local_daemon sets it with command_listener._LOCAL_HOST)
LOCAL_HOST = None


def _reconciler_script(argv):
    """The reconciler path this argv RUNS, or None. A run is `python [options]
    <script>` or the desktop daemon's `local_daemon.py --run-reconciler
    <script>`; -m / -c (py_compile, a one-liner) only read the file."""
    if len(argv) < 2 or not os.path.basename(argv[0].replace("\\", "/")).lower().startswith("python"):
        return None
    i = 1
    while i < len(argv) and argv[i].startswith("-") and argv[i] != "-":
        opt = argv[i]
        i += 1
        if opt == "--":
            break
        if opt.startswith("--"):
            continue
        for k, ch in enumerate(opt[1:], 1):
            if ch in "cm":
                return None
            if ch in "WX":
                if k == len(opt) - 1:
                    i += 1  # its value is the next word
                break
    if i >= len(argv):
        return None
    script = argv[i]
    name = os.path.basename(script.replace("\\", "/"))
    if name == "reconciler.py":
        return script
    if name == "local_daemon.py" and argv[i + 1:i + 2] == ["--run-reconciler"] and len(argv) > i + 2:
        return argv[i + 2] if os.path.basename(argv[i + 2].replace("\\", "/")) == "reconciler.py" else None
    return None


def _runs_reconciler(argv, cwd, target):
    """argv runs this workspace's manager/reconciler.py. A relative path is
    resolved against the process's cwd; with no cwd (unreadable, or Windows,
    where target is None too) naming manager/reconciler.py is enough: one
    workspace per machine."""
    script = _reconciler_script(argv)
    if script is None:
        return False
    norm = script.replace("\\", "/")
    if target is None or (cwd is None and not os.path.isabs(script)):
        return norm.endswith("manager/reconciler.py")
    if os.path.isabs(script):
        return os.path.realpath(script) == target
    return os.path.realpath(os.path.join(cwd, script)) == target


def _proc_supervised(proc, pid):
    """Linux: will _restart_reconciler replace this process? Yes when it runs in
    the systemd unit's cgroup (systemctl restart) or under tmux (kill-session)."""
    try:
        with open(os.path.join(proc, str(pid), "cgroup")) as f:
            if RECONCILER_UNIT in f.read():
                return True
    except OSError:
        pass
    seen = set()
    while pid > 1 and pid not in seen and len(seen) < 32:
        seen.add(pid)
        try:
            with open(os.path.join(proc, str(pid), "stat")) as f:
                pid = int(f.read().rsplit(")", 1)[1].split()[1])
            with open(os.path.join(proc, str(pid), "cmdline"), "rb") as f:
                arg0 = f.read().split(b"\0", 1)[0].decode("utf-8", "replace")
        except (OSError, ValueError, IndexError):
            return False
        # the tmux server retitles itself "tmux: server (/tmp/tmux-N/default)"
        if os.path.basename(arg0.split(" ", 1)[0]).startswith("tmux"):
            return True
    return False


def unsupervised_reconciler_pids(proc="/proc", all_=False, workspace=None):
    """pids running this workspace's reconciler that no supervisor restart would
    replace (ours excluded), or None when the process list cannot be read.
    /proc is read directly, not pgrep -f: a pattern on a command line also
    matches whatever runs the pattern."""
    target = os.path.realpath(os.path.join(workspace or WORKSPACE, "manager", "reconciler.py"))
    me = os.getpid()
    if platform.system() == "Windows":
        return _windows_unsupervised_pids(me, all_)
    try:
        entries = os.listdir(proc)
    except OSError:
        return None
    pids = []
    for d in entries:
        if not d.isdigit() or int(d) == me:
            continue
        try:
            with open(os.path.join(proc, d, "cmdline"), "rb") as f:
                argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
        except OSError:
            continue  # gone meanwhile
        try:
            cwd = os.readlink(os.path.join(proc, d, "cwd"))
        except OSError:
            cwd = None
        if _runs_reconciler(argv, cwd, target) and (all_ or not _proc_supervised(proc, int(d))):
            pids.append(int(d))
    return pids


def _windows_unsupervised_pids(me, all_=False):
    ps = ("Get-CimInstance Win32_Process | ForEach-Object { "
          "\"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                             capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
                             **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return _parse_windows_unsupervised(out.stdout, me, all_)


def _parse_windows_unsupervised(text, me, all_=False):
    """Win32_Process rows `pid<TAB>ppid<TAB>name<TAB>cmdline`. There is no cwd:
    a python whose command line runs manager\\reconciler.py counts (one
    workspace per machine). Supervised = an nssm.exe ancestor (the service
    that nssm stop/start replaces)."""
    rows = {}
    for line in (text or "").splitlines():
        parts = line.split("\t", 3)
        if len(parts) == 4 and parts[0].strip().isdigit() and parts[1].strip().isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2].strip().lower(), parts[3])
    pids = []
    for pid, (ppid, _, cmdline) in rows.items():
        if pid == me:
            continue
        argv = [q or u for q, u in re.findall(r'"([^"]*)"|(\S+)', cmdline)]
        if not _runs_reconciler(argv, None, None):
            continue
        seen, up, supervised = {pid}, ppid, False
        while up in rows and up not in seen:
            seen.add(up)
            if rows[up][1] == "nssm.exe":
                supervised = True
                break
            up = rows[up][0]
        if all_ or not supervised:
            pids.append(pid)
    return pids


RECONCILER_SINGLETON = os.path.join("state", "reconciler.pid")  # = manager/reconciler.SINGLETON_PATH
UPDATE_HOLD_STALE_S = 900  # = manager/reconciler.UPDATE_HOLD_STALE_S


def lock_file_free(path):
    """Nobody holds the exclusive lock on `path` (reconciler.py's singleton, or
    local_daemon's): taken and dropped at once. A missing file is free; any
    doubt is held. The OS drops these locks on every exit, SIGKILL included."""
    try:
        fd = os.open(path, os.O_RDWR)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    try:
        try:
            import fcntl
        except ImportError:
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


def update_hold_fresh(state=None):
    """manager/update_workspace.py is swapping files (state/execution/hold)."""
    try:
        age = time.time() - os.path.getmtime(os.path.join(state or WORKSPACE_STATE, "execution", "hold"))
    except OSError:
        return False
    return age <= UPDATE_HOLD_STALE_S



STOP_MARK_NAME = "reconciler_stop_mark"   # = command_listener.RECONCILER_STOP_MARK (state/)


def heartbeat_live(state_dir, now=None):
    """The reconciler's heartbeat is fresh AND newer than the runtime's stop mark. A mark
    written after the last beat is a confirmed stop (unbind, restart) — the heartbeat stays
    'fresh' for HEARTBEAT_STALE_S afterwards, but nothing is beating it."""
    try:
        hb = os.path.getmtime(os.path.join(state_dir, "heartbeat", "reconciler"))
    except OSError:
        return False
    if (now if now is not None else time.time()) - hb > HEARTBEAT_STALE_S:
        return False
    try:
        return hb > os.path.getmtime(os.path.join(state_dir, STOP_MARK_NAME))
    except OSError:
        return True


def absent(local, host, pids, workspace=None):
    """True only when it is CERTAIN no reconciler process exists for this
    workspace — so the next one to start loads the lib on disk. Stale heartbeat
    alone is not enough (stuck in a broker call, just back from sleep, an old
    process waiting on a deferred restart). Desktop (`local`): the daemon's own
    supervisor (`host`) answers under its lock (no spawn can race it), plus the
    singleton lock. Cloud: no reconciler.py in the process list (`pids()`,
    supervised or not — a pre-singleton reconciler takes no lock) AND the
    singleton lock is free AND no workspace update is swapping files.
    Unreadable anything = False. Taking the singleton lock can make a
    reconciler starting in that instant exit 75: start_reconciler.sh retries
    that quietly in 10 s."""
    ws = workspace or WORKSPACE
    state = os.path.join(ws, "state")
    if update_hold_fresh(state):
        return False
    if heartbeat_live(state):   # a live heartbeat is a process, whatever the probes say
        return False
    if local:
        probe = getattr(host, "idle_for_sure", None)
        return bool(probe and probe())
    found = pids()
    if found is None or found:
        return False
    return lock_file_free(os.path.join(ws, RECONCILER_SINGLETON))
