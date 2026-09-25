"""runtime/local_daemon.py on Windows, checked on a POSIX box: _nt() is
monkeypatched, msvcrt is a fake with Windows semantics (per-handle, a second
handle in the SAME process is refused too), kernel32 is a fake. The three
guarantees of the module docstring, each on its Windows equivalent:

  1. parent watch: EOF on stdin AND the parent's process handle both reach the
     same "parent gone" result; a real --run-reconciler child in nt mode leaves
     on EOF and runs its exit sweep with no signal involved.
  2. lock: fcntl / msvcrt each take and refuse; the reconciler takes its own
     lock (refused → exit 3); the daemon confirms the child holds it, restarts
     when the child drops it, kills a child that never takes it; no pass_fds.
  3. signal: stop = close stdin first, terminate only on timeout; an orphan is
     stopped without touching signal.SIGKILL.
Plus: <base>/current is a junction, an orphan is recognised by this install's
script path (no cwd on Windows), and main() refuses only when BOTH lock
modules are missing.
Run: cd blave-agent && .venv/bin/python tests/check_local_daemon_windows.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.environ.get("CHECK_RUNTIME_DIR") or os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="local-daemon-win-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
sys.path.insert(0, RUNTIME)
import local_daemon as ld  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg, flush=True)
    fails += 0 if cond else 1


class FakeMsvcrt:
    """Byte-range locks keyed by file identity, owned by an fd. Windows refuses
    a second handle of the same process as well, so no pid in the key."""
    LK_NBLCK, LK_LOCK, LK_UNLCK = 2, 1, 0

    def __init__(self):
        self.held, self.modes = {}, []

    @staticmethod
    def _key(fd):
        st = os.fstat(fd)
        return (st.st_dev, st.st_ino)

    def locking(self, fd, mode, n):
        self.modes.append(mode)
        k = self._key(fd)
        if mode == self.LK_UNLCK:
            if self.held.get(k) == fd:
                del self.held[k]
            return
        if k in self.held and self.held[k] != fd:
            raise OSError(13, "locked")
        self.held[k] = fd

    def drop(self, fd):
        """What the OS does when the owning process ends."""
        for k, v in list(self.held.items()):
            if v == fd:
                del self.held[k]


def nt_mode(on=True):
    ld._nt = (lambda: True) if on else (lambda: os.name == "nt")
    if on:
        ld.fcntl, ld.msvcrt = None, FakeMsvcrt()
    else:
        import fcntl as real_fcntl
        ld.fcntl, ld.msvcrt = real_fcntl, None


def within(seconds, fn):
    """fn's return value, or None if it did not return in time."""
    box = []
    t = threading.Thread(target=lambda: box.append(fn()), daemon=True)
    t.start()
    t.join(seconds)
    return box[0] if box else None


# ── 1. parent watch ──────────────────────────────────────────────────────────
nt_mode(True)
never = threading.Event()
block = lambda pid: never.wait() and False  # noqa: E731 — a wait that never ends

r, w = os.pipe()
threading.Timer(0.3, os.close, args=(w,)).start()
check(within(3, lambda: ld._wait_parent_gone_nt(4242, fd=r, wait_pid=block)) == "parent closed stdin",
      "[watch] stdin EOF → 'parent closed stdin' (parent handle still alive)")
os.close(r)

r, w = os.pipe()  # write end stays open: only the process watch can fire
seen = []
gone = threading.Event()


def fake_wait_pid(pid):
    seen.append(pid)
    gone.wait()
    return True


threading.Timer(0.3, gone.set).start()
check(within(3, lambda: ld._wait_parent_gone_nt(4242, fd=r, wait_pid=fake_wait_pid)) == "parent process is gone"
      and seen == [4242], "[watch] parent handle signalled, pipe still open → 'parent process is gone'")
os.close(w)
os.close(r)

# through the public entry (fd 0 swapped for a pipe): the same result the POSIX path returns
r, w = os.pipe()
saved0 = os.dup(0)
os.dup2(r, 0)
real_wait_pid, ld._wait_pid_nt = ld._wait_pid_nt, block
threading.Timer(0.3, os.close, args=(w,)).start()
why = within(3, lambda: ld._wait_parent_gone(os.getppid()))
os.dup2(saved0, 0)
os.close(saved0)
os.close(r)
check(why == "parent closed stdin", "[watch] _wait_parent_gone dispatches to the nt watch under nt")

# Daemon._watch_parent: EOF sets the same stop event SIGTERM sets
r, w = os.pipe()
saved0 = os.dup(0)
os.dup2(r, 0)
d = types.SimpleNamespace(_ppid=os.getppid(), stop=threading.Event())
threading.Thread(target=ld.Daemon._watch_parent, args=(d,), daemon=True).start()
time.sleep(0.2)
check(not d.stop.is_set(), "[watch] daemon keeps running while stdin is open")
os.close(w)
check(d.stop.wait(3), "[watch] EOF → Daemon.stop set (the callback the POSIX path fires)")
os.dup2(saved0, 0)
os.close(saved0)
os.close(r)
ld._wait_pid_nt = real_wait_pid

# _wait_pid_nt against a fake kernel32
calls = []
wait_ev = threading.Event()


class K32:
    def __init__(self, handle, err=0):
        self.handle, self.err = handle, err

    def OpenProcess(self, access, inherit, pid):
        calls.append(("OpenProcess", access, inherit, pid))
        return self.handle

    def GetLastError(self):
        return self.err

    def WaitForSingleObject(self, h, ms):
        calls.append(("Wait", h, ms))
        wait_ev.wait()
        return 0

    def CloseHandle(self, h):
        calls.append(("Close", h))


ld._kernel32 = lambda: K32(0, ld._ERROR_INVALID_PARAMETER)
check(ld._wait_pid_nt(7) is True, "[kernel32] OpenProcess fails with ERROR_INVALID_PARAMETER → parent already gone")
ld._kernel32 = lambda: K32(0, 5)
check(ld._wait_pid_nt(7) is False, "[kernel32] OpenProcess fails otherwise → cannot watch (EOF watch remains)")
calls.clear()
ld._kernel32 = lambda: K32(42)
threading.Timer(0.3, wait_ev.set).start()
check(within(3, lambda: ld._wait_pid_nt(7)) is True
      and calls == [("OpenProcess", ld._SYNCHRONIZE, False, 7), ("Wait", 42, ld._INFINITE), ("Close", 42)],
      f"[kernel32] SYNCHRONIZE handle, INFINITE wait, handle closed: {calls}")

# a real --run-reconciler child in nt mode: EOF alone → exit sweep → exit 0, no signal sent
WS = os.path.join(BASE, "ws")
os.makedirs(os.path.join(WS, "lib"))
os.makedirs(os.path.join(WS, "state"))
open(os.path.join(WS, "lib", "__init__.py"), "w").write("")
open(os.path.join(WS, "lib", "venue_wiring.py"), "w").write(
    "def sweep_orphan_orders():\n    open('state/swept', 'w').write('1')\n    return 1\n")
open(os.path.join(WS, "fake_reconciler.py"), "w").write(
    "import local_daemon, time\n"
    "open('state/lock_taken', 'w').write(str(local_daemon._RECONCILER_LOCK_FD is not None))\n"
    "time.sleep(60)\n")
BOOT = (
    "import os, sys, types\n"
    f"sys.path.insert(0, {RUNTIME!r})\n"
    "import local_daemon as ld\n"
    "ld._nt = lambda: True\n"
    "ld.fcntl = None\n"
    "class M:\n"
    "    LK_NBLCK, LK_LOCK, LK_UNLCK = 2, 1, 0\n"
    "    def locking(self, fd, mode, n):\n"
    "        if os.environ.get('FAKE_LOCK_HELD') and mode == 2: raise OSError(13, 'locked')\n"
    "ld.msvcrt = M()\n"
    "ld._wait_pid_nt = lambda pid: __import__('threading').Event().wait()\n"
    "ld.LOCK_TAKE_S = 0.3\n"
    "ld.run_reconciler('fake_reconciler.py')\n")
env = dict(os.environ, BLAVE_AGENT_WORKSPACE=WS)
p = subprocess.Popen([sys.executable, "-c", BOOT], cwd=WS, env=env, stdin=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True)
for _ in range(50):
    if os.path.exists(os.path.join(WS, "state", "lock_taken")):
        break
    time.sleep(0.1)
check(open(os.path.join(WS, "state", "lock_taken")).read() == "True",
      "[reconciler nt] child took state/local_reconciler.lock itself before running the script")
check(p.poll() is None, "[reconciler nt] child stays up while the daemon holds its stdin")
p.stdin.close()
try:
    rc = p.wait(ld.SWEEP_BUDGET_S + 5)
except subprocess.TimeoutExpired:
    p.kill()
    rc = None
err = p.stderr.read()
check(rc == 0 and os.path.exists(os.path.join(WS, "state", "swept")) and "reconciler leaving" in err,
      f"[reconciler nt] stdin EOF → exit sweep ran, exit 0, no signal (rc={rc})")
os.remove(os.path.join(WS, "state", "lock_taken"))
p = subprocess.run([sys.executable, "-c", BOOT], cwd=WS, env=dict(env, FAKE_LOCK_HELD="1"),
                   stdin=subprocess.PIPE, capture_output=True, text=True, timeout=30)
check(p.returncode == 3 and "holds the lock" in p.stderr and not os.path.exists(os.path.join(WS, "state", "lock_taken")),
      f"[reconciler nt] lock held elsewhere → exit 3 before the script runs (rc={p.returncode})")

# ── 2. the lock, both tracks ─────────────────────────────────────────────────
LOCKF = os.path.join(BASE, "x.lock")
nt_mode(False)
a = os.open(LOCKF, os.O_CREAT | os.O_RDWR, 0o600)
b = os.open(LOCKF, os.O_CREAT | os.O_RDWR, 0o600)
ld._lock_fd(a)
try:
    ld._lock_fd(b)
    check(False, "[lock posix] second flock refused")
except OSError:
    check(True, "[lock posix] second flock refused")
ld._release_fd(a)
ld._lock_fd(b)
check(True, "[lock posix] released → the other fd takes it")
ld._release_fd(b)

nt_mode(True)
a = os.open(LOCKF, os.O_CREAT | os.O_RDWR, 0o600)
b = os.open(LOCKF, os.O_CREAT | os.O_RDWR, 0o600)
ld._lock_fd(a)
try:
    ld._lock_fd(b)
    check(False, "[lock nt] second handle refused")
except OSError:
    check(True, "[lock nt] second handle refused")
check(ld.msvcrt.modes == [2, 2], "[lock nt] non-blocking LK_NBLCK, never the 10-second LK_LOCK")
os.write(a, b"123")  # moves the position, as the pid write does
ld._release_fd(a)
check(ld.msvcrt.modes[-1] == 0 and not ld.msvcrt.held, "[lock nt] release unlocks byte 0 (seeks back first) before close")
ld._lock_fd(b)
check(True, "[lock nt] released → the other handle takes it")
ld._release_fd(b)

s1, s2 = ld.SingleInstance(LOCKF), ld.SingleInstance(LOCKF)
check(s1.acquire() is True and s2.acquire() is False, "[lock nt] SingleInstance: first yes, second no")
check(open(LOCKF).read() == str(os.getpid()), "[lock nt] pid written for humans")
ld.msvcrt.drop(s1.fd)
os.close(s1.fd)

logs = []
ld._log = logs.append
ld.fcntl = ld.msvcrt = None
check(ld.main([]) == 2 and "fcntl" in logs[-1] and "msvcrt" in logs[-1],
      "[gate] neither fcntl nor msvcrt → exit 2, names both")
ld.msvcrt = FakeMsvcrt()
os.environ.pop("BLAVE_AGENT_LOCAL", None)
check(ld.main([]) == 2 and "BLAVE_AGENT_LOCAL" in logs[-1], "[gate] msvcrt alone passes the lock gate (next gate speaks)")

# ── 3. supervisor in nt mode: the child takes the lock, the daemon confirms ──
nt_mode(True)
WS2 = os.path.join(BASE, "ws2")
os.makedirs(os.path.join(WS2, "state"))
lock_path = os.path.join(WS2, ld.RECONCILER_LOCK)
popen_kw = []


class FakeChild:
    """A reconciler as the daemon sees it: takes the lock on its own fd after
    `take_after` seconds (None = never), exits when told."""
    _next = 900

    def __init__(self, take_after=0.05, exit_now=False):
        FakeChild._next += 1
        self.pid, self.returncode = FakeChild._next, (1 if exit_now else None)
        self.stdin = types.SimpleNamespace(closed=False, close=lambda: setattr(self.stdin, "closed", True))
        self.fd, self.log = None, []
        if take_after is not None and not exit_now:
            threading.Timer(take_after, self._take).start()

    def _take(self):
        self.fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        ld.msvcrt.locking(self.fd, 2, 1)

    def die(self, code=1):
        if self.fd is not None:
            ld.msvcrt.drop(self.fd)
        self.returncode = code

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        end = time.time() + (timeout or 0)
        while self.returncode is None and time.time() < end:
            time.sleep(0.05)
        if self.returncode is None:
            raise subprocess.TimeoutExpired("x", timeout)
        return self.returncode

    def terminate(self):
        self.log.append("terminate")

    def kill(self):
        self.log.append("kill")
        self.die(-9)


children = []


def fake_popen(argv, **kw):
    popen_kw.append(kw)
    c = children.pop(0)
    return c


real_popen = ld.subprocess.Popen
ld.subprocess.Popen = fake_popen
sup = ld.ReconcilerSupervisor(WS2, lambda: {}, lambda pid: "", lambda **kw: kw)
children.append(FakeChild())
sup.restart_reconciler()
c1 = sup._proc
check(c1 is not None and "pass_fds" not in popen_kw[-1], "[sup nt] spawned without pass_fds")
check(c1.fd is not None and sup.info()["running"] is True and sup.info()["pid"] == c1.pid,
      "[sup nt] child took the lock, daemon confirmed it, status running")
check(open(os.path.join(WS2, "state", "local_reconciler.pid")).read() == str(c1.pid), "[sup nt] pid file written")
c1.die(1)
ld.RESTART_DELAY_S = 0
children.append(FakeChild())
sup.tick()
sup.tick()
c2 = sup._proc
check(c2 is not c1 and sup.restarts == 1 and sup.last_exit_code == 1 and c2.fd is not None,
      "[sup nt] child dropped the lock (exited) → restarted, new child holds it")

# stop: stdin closed first, terminate never; the child leaves on EOF
c2_closed_before_exit = []
orig_close = c2.stdin.close


def close_then_exit():
    orig_close()
    c2_closed_before_exit.append(True)
    threading.Timer(0.1, lambda: c2.die(0)).start()


c2.stdin.close = close_then_exit
check(sup.stop_reconciler() is True and c2_closed_before_exit and c2.log == [],
      "[sup nt] stop = close stdin (EOF), child leaves, no terminate/kill")

ld.STOP_GRACE_S = 0.3
children.append(FakeChild())
sup.restart_reconciler()
c3 = sup._proc
check(sup.stop_reconciler() is True and c3.log == ["kill"],
      "[sup nt] child ignoring EOF → killed after STOP_GRACE_S, still no terminate()")

ld.LOCK_TAKE_S = 0.3
children.append(FakeChild(take_after=None))
try:
    sup.restart_reconciler()
    check(False, "[sup nt] child never takes the lock → RuntimeError")
except RuntimeError as e:
    check("did not take its lock" in str(e) and children == [] and sup._proc is None,
          f"[sup nt] child never takes the lock → killed + RuntimeError: {e}")
children.append(FakeChild(exit_now=True))
try:
    sup.restart_reconciler()
    check(False, "[sup nt] child exits before locking → RuntimeError")
except RuntimeError as e:
    check("exited before" in str(e), f"[sup nt] child exits before locking → RuntimeError: {e}")

# POSIX path untouched: pass_fds still there, terminate() still first
nt_mode(False)
children.append(FakeChild(take_after=None))
sup.restart_reconciler()
c4 = sup._proc
check(popen_kw[-1].get("pass_fds") and len(popen_kw[-1]["pass_fds"]) == 1, "[sup posix] spawned with pass_fds=(fd,)")
threading.Timer(0.1, lambda: c4.die(0)).start()
sup.stop_reconciler()
check(c4.log == ["terminate"], "[sup posix] stop still starts with terminate()")
ld.subprocess.Popen = real_popen

# orphan: recognised by this install's script on the command line (no cwd on Windows)
nt_mode(True)
me = os.path.abspath(ld.__file__)
with open(os.path.join(WS2, "state", "local_reconciler.pid"), "w") as f:
    f.write("777")
sup._pid_cmdline = lambda pid: f'"C:\\Blave\\venv\\Scripts\\python.exe" "{me}" --run-reconciler manager\\reconciler.py'
check(sup._orphan_pid() == 777 and ld._pid_cwd(777) == "", "[orphan nt] our script + reconciler.py on the cmdline → ours")
sup._pid_cmdline = lambda pid: 'python.exe C:\\other\\local_daemon.py --run-reconciler manager\\reconciler.py'
check(sup._orphan_pid() is None, "[orphan nt] another install's daemon → not ours")
sup._pid_cmdline = lambda pid: f'"{me}" --run-reconciler manager\\reconciler.py'
holder = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
ld.msvcrt.locking(holder, 2, 1)
kills = []
real_kill, real_signal = os.kill, ld.signal


def fake_kill(pid, sig):
    kills.append((pid, sig))
    ld.msvcrt.drop(holder)  # the orphan is gone, its lock with it


os.kill = fake_kill
ld.signal = types.SimpleNamespace(SIGTERM=15, SIGINT=2)  # a Windows signal module: no SIGKILL
fd = sup._free_lock()
os.kill, ld.signal = real_kill, real_signal
check(fd is not None and kills == [(777, 15)], f"[orphan nt] terminated with SIGTERM only, no SIGKILL attribute: {kills}")
ld._release_fd(fd)
os.close(holder)

# ── 4. <base>/current is a junction ──────────────────────────────────────────
nt_mode(True)
junctions, made = set(), []


def fake_create_junction(target, path):
    made.append((target, path))
    os.mkdir(path)
    junctions.add(os.path.realpath(path))


sys.modules["_winapi"] = types.SimpleNamespace(CreateJunction=fake_create_junction)
real_isjunction = os.path.isjunction
os.path.isjunction = lambda p: os.path.realpath(p) in junctions
B2 = os.path.join(BASE, "base2")
os.makedirs(B2)
here = os.path.dirname(os.path.abspath(ld.__file__))
ld._link_current(B2)
check(made == [(here, os.path.join(B2, "current"))], "[junction] no current → CreateJunction(runtime dir, <base>/current)")
ld._link_current(B2)  # a junction that does not resolve to `here` (the fake is a plain dir) is re-pointed
check(len(made) == 2 and os.path.isdir(os.path.join(B2, "current")), "[junction] stale junction → rmdir + CreateJunction, no rename")
shutil.rmtree(os.path.join(B2, "current"))
junctions.clear()
os.mkdir(os.path.join(B2, "current"))
made.clear()
ld._link_current(B2)
check(made == [] and os.path.isdir(os.path.join(B2, "current")), "[junction] a real directory named current is left alone")
os.path.isjunction = real_isjunction
del sys.modules["_winapi"]

# ── 5. POSIX flags that Windows lacks are looked up, not assumed ─────────────
src = open(os.path.join(RUNTIME, "local_daemon.py"), encoding="utf-8").read()
check("os.O_NOFOLLOW" not in src and "os.O_NONBLOCK" not in src and 'getattr(os, "O_NOFOLLOW", 0)' in src,
      "[src] O_NONBLOCK / O_NOFOLLOW via getattr (absent on Windows)")
check(src.count("signal.SIGKILL") == 1 and 'if hasattr(signal, "SIGKILL"):' in src,
      "[src] signal.SIGKILL used once, behind hasattr")

shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
