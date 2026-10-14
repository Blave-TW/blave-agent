"""How many performance refreshes (`stats_refresh`) may run at once, and what each costs.

Stdlib plus runtime/atomic_file only (never the workspace). Reads free memory, core count and one child's memory; decides whether one more
refresh may start now. Never starts, stops or signals anything except raising a refresh child's
OOM score on Linux (so the kernel takes it, never the reconciler).

The rule (Wei 10-14): start the next one only while fewer than
min(MAX_PARALLEL, cores // 2) run AND free memory, less RESERVE_MB and less what the running
ones may still grow by (their estimate minus their memory now), covers the next one's estimate.
Re-judged before every start. Nothing running = always start one (the old one-at-a-time floor).
Free memory unreadable = one at a time. A wrong guess only makes refreshes slower (they wait),
and on Linux a refresh child is the OOM killer's first choice.
"""
import json
import os
import platform
import subprocess
import time

MAX_PARALLEL = 4
# No record yet (no fleet measurement exists before this file starts keeping them): a backtest
# holds years of bars in pandas plus the MCPT permutations, and a 1-min strategy's cold run is
# known to swap a 1 GB box. 1.5 GB errs high on purpose — an unmeasured strategy is not started
# beside another unless ~2.5 GB+ is free; after its first run its own measured peak is used.
DEFAULT_PEAK_MB = 1536
# Kept free for what is not a refresh but may start or grow meanwhile: a live tick, an agent
# turn's engine, the reconciler's own growth, the OS. Processes already running are counted in
# "available" already, so this is only room for change; 1 GB rather than 512 MB because a wrong
# guess here costs only speed, while too little starves the reconciler.
RESERVE_MB = 1024
COST_FILE = ".perf_cost.json"   # strategies/<name>/: {"seconds", "peak_mb", "at"}
SAMPLE_S = 0.5                  # Linux /proc and Windows handle reads: cheap
SAMPLE_MAC_S = 2.0              # macOS spawns `ps` per sample


def cpu_slots():
    return max(1, min(MAX_PARALLEL, (os.cpu_count() or 1) // 2))


def available_memory_mb():
    """Free memory the OS can hand out now, in MB; None when it cannot be read."""
    system = platform.system()
    try:
        if system == "Linux":
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) // 1024
            return None
        if system == "Darwin":
            return _parse_vm_stat(subprocess.run(["vm_stat"], capture_output=True, text=True,
                                                 timeout=5).stdout)
        if system == "Windows":
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return None
            # Windows does not overcommit: when the commit limit runs out, the allocation that
            # fails may be the reconciler's, not the refresh's — so the smaller of the two
            return win_available_mb(st.ullAvailPhys, st.ullAvailPageFile)
    except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
        return None
    return None


def win_available_mb(avail_phys, avail_pagefile):
    """GlobalMemoryStatusEx bytes → MB: the smaller of free physical memory and the commit
    charge left (ullAvailPageFile is commit limit − commit charge)."""
    return int(min(avail_phys, avail_pagefile) // (1024 * 1024))


def _parse_vm_stat(text):
    """Free + inactive + speculative pages (what macOS hands out without swapping)."""
    lines = (text or "").splitlines()
    if not lines or "page size of" not in lines[0]:
        return None
    page = int(lines[0].split("page size of")[1].split()[0])
    pages = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            try:
                pages[k.strip()] = int(v.strip().rstrip("."))
            except ValueError:
                continue
    if "Pages free" not in pages:
        return None
    n = sum(pages.get(k, 0) for k in ("Pages free", "Pages inactive", "Pages speculative"))
    return n * page // (1024 * 1024)


def may_start(next_mb, running, free_mb=None, slots=None):
    """Start one more refresh needing about `next_mb`? `running` = [(estimate_mb, now_mb)] of the
    ones running. `free_mb` / `slots` are read when not given."""
    if not running:
        return True
    if len(running) >= (cpu_slots() if slots is None else slots):
        return False
    free = available_memory_mb() if free_mb is None else free_mb
    if free is None:
        return False
    growth = sum(max(0, est - (now or 0)) for est, now in running)
    return free - RESERVE_MB - growth >= next_mb


def read_cost(sdir):
    try:
        with open(os.path.join(sdir, COST_FILE), encoding="utf-8") as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def estimate_mb(sdir):
    peak = read_cost(sdir).get("peak_mb")
    if not isinstance(peak, (int, float)) or isinstance(peak, bool) or peak <= 0:
        return DEFAULT_PEAK_MB
    return int(peak)


def last_seconds(sdir):
    s = read_cost(sdir).get("seconds")
    return float(s) if isinstance(s, (int, float)) and not isinstance(s, bool) and s >= 0 else None


def write_cost(sdir, peak_mb, seconds):
    """Peak (any finished run) and, on success, seconds. Best-effort: a lost record only means
    the default estimate / the back of the queue next time. Never recreates a deleted folder."""
    if not os.path.isdir(sdir):
        return
    doc = read_cost(sdir)
    if peak_mb:
        doc["peak_mb"] = int(peak_mb)
    if seconds is not None:
        doc["seconds"] = round(float(seconds), 1)
    doc["at"] = int(time.time())
    try:
        import atomic_file  # same runtime dir: the one replace convention (temp name, symlink-safe)
        with atomic_file.replacing(os.path.join(sdir, COST_FILE)) as f:
            json.dump(doc, f)
    except OSError:
        pass


OOM_ADJ_PATH = "/proc/{pid}/oom_score_adj"
OOM_ADJ = 1000


def demote_oom(pid):
    """Linux: the refresh child is the OOM killer's first pick (oom_score_adj 1000, raising
    one's own process's score needs no privilege). Elsewhere a no-op."""
    try:
        with open(OOM_ADJ_PATH.format(pid=pid), "w") as f:
            f.write(str(OOM_ADJ))
    except OSError:
        pass


def rss_mb(proc):
    """The child's peak memory so far in MB (Linux VmHWM, Windows PeakWorkingSetSize, macOS the
    current RSS — sampled, so the caller keeps the max); None when it cannot be read."""
    system = platform.system()
    try:
        if system == "Linux":
            with open(f"/proc/{proc.pid}/status") as f:
                for line in f:
                    if line.startswith("VmHWM:"):
                        return int(line.split()[1]) // 1024
            return None
        if system == "Darwin":
            out = subprocess.run(["ps", "-o", "rss=", "-p", str(proc.pid)], capture_output=True,
                                 text=True, timeout=5).stdout.strip()
            return int(out) // 1024 if out else None
        if system == "Windows":
            # the venv's python.exe is a launcher: the interpreter that holds the memory is its
            # child — the peak of the whole process tree, sampled while it runs
            return _win_tree_peak_mb(proc)
    except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
        return None
    return None


def tree_pids(root, rows):
    """`root` and every descendant in rows [(pid, ppid)] (a pid reused by an unrelated process
    after its parent died can slip in — only the max is kept, so at worst an over-estimate)."""
    kids = {}
    for pid, ppid in rows:
        if pid != ppid:
            kids.setdefault(ppid, []).append(pid)
    out, todo = [], [root]
    while todo and len(out) < 64:
        pid = todo.pop()
        if pid in out:
            continue
        out.append(pid)
        todo.extend(kids.get(pid, []))
    return out


def _win_tree_peak_mb(proc):
    import ctypes
    from ctypes import wintypes

    k32, psapi = ctypes.windll.kernel32, ctypes.windll.psapi

    class PE(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260)]

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

    def peak_of(handle):
        c = PMC()
        c.cb = ctypes.sizeof(PMC)
        return c.PeakWorkingSetSize if psapi.GetProcessMemoryInfo(handle, ctypes.byref(c), c.cb) else 0

    best = peak_of(int(proc._handle))   # the launcher itself (readable after exit too)
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)   # TH32CS_SNAPPROCESS
    rows = []
    if snap and snap != wintypes.HANDLE(-1).value:
        try:
            e = PE()
            e.dwSize = ctypes.sizeof(PE)
            ok = k32.Process32First(snap, ctypes.byref(e))
            while ok:
                rows.append((e.th32ProcessID, e.th32ParentProcessID))
                ok = k32.Process32Next(snap, ctypes.byref(e))
        finally:
            k32.CloseHandle(snap)
    if not rows:
        return None   # the tree could not be walked: the launcher alone is not a measurement
    k32.OpenProcess.restype = wintypes.HANDLE
    for pid in tree_pids(proc.pid, rows)[1:]:
        h = k32.OpenProcess(0x1000 | 0x0010, False, pid)   # QUERY_LIMITED_INFORMATION | VM_READ
        if not h:
            continue
        try:
            best = max(best, peak_of(h))
        finally:
            k32.CloseHandle(h)
    return int(best // (1024 * 1024)) or None


def maxrss_mb(ru_maxrss):
    """rusage ru_maxrss in MB: bytes on macOS, kilobytes on Linux."""
    return int(ru_maxrss // (1024 * 1024)) if platform.system() == "Darwin" else int(ru_maxrss // 1024)


def sample_interval():
    return SAMPLE_MAC_S if platform.system() == "Darwin" else SAMPLE_S
