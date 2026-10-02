"""runtime/local_daemon.py — the Windows stdin watch must never park a read on
the pipe (0.1.12 Windows e2e: the reconciler froze for good inside
`import numpy`, OpenBLAS's DLL init waiting on the CRT lock that the watch
thread's blocking read(0) held).

  1. Logic, any OS (nt watch driven with a FIONREAD peek on a POSIX pipe):
     EOF is seen; data the app writes is drained and the watch keeps going;
     while the pipe is open and empty no read() is ever in progress; a handle
     that cannot be peeked falls back to the blocking read and still sees EOF;
     on a POSIX box the real peek reports "cannot peek" instead of raising.
  2. Windows only, the real thing: a child whose stdin is a pipe the parent
     keeps open starts the watch through the public entry and then imports
     numpy — that must finish within IMPORT_LIMIT_S. Elsewhere it prints SKIP
     for this part only. The same child with the watch forced back to the
     blocking read is run as an informational control (printed, not checked).
Run: cd blave-agent && .venv/bin/python tests/check_parent_watch_peek.py
     (Windows: <venv>\\Scripts\\python.exe tests\\check_parent_watch_peek.py)
"""
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.environ.get("CHECK_RUNTIME_DIR") or os.path.join(ROOT, "runtime")
sys.path.insert(0, RUNTIME)
import local_daemon as ld  # noqa: E402

IMPORT_LIMIT_S = 20
fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg, flush=True)
    fails += 0 if cond else 1


def within(seconds, fn):
    box = []
    t = threading.Thread(target=lambda: box.append(fn()), daemon=True)
    t.start()
    t.join(seconds)
    return box[0] if box else None


never = threading.Event()
block = lambda pid: never.wait() and False  # noqa: E731 — the parent handle never fires

# ── 1. logic ────────────────────────────────────────────────────────────────
if os.name != "nt":
    import fcntl
    import select
    import struct
    import termios

    def posix_peek(fd):
        """PeekNamedPipe's contract on a POSIX pipe: bytes waiting, None at EOF."""
        n = struct.unpack("i", fcntl.ioctl(fd, termios.FIONREAD, b"\0\0\0\0"))[0]
        if n == 0 and select.select([fd], [], [], 0)[0]:
            return None  # readable with nothing in it = the write end is closed
        return n

    class ReadSpy:
        """ld.os with read() instrumented: who is inside it right now, and how often."""
        def __init__(self):
            self.inside, self.calls = 0, 0

        def read(self, fd, n):
            self.inside += 1
            self.calls += 1
            try:
                return os.read(fd, n)
            finally:
                self.inside -= 1

        def __getattr__(self, name):
            return getattr(os, name)

    spy = ReadSpy()
    real_os, ld.os = ld.os, spy
    try:
        r, w = os.pipe()
        threading.Timer(0.5, os.close, args=(w,)).start()
        check(within(3, lambda: ld._wait_parent_gone_nt(4242, fd=r, wait_pid=block, peek=posix_peek))
              == "parent closed stdin", "[peek] write end closed → 'parent closed stdin'")
        os.close(r)

        r, w = os.pipe()
        box = []
        t = threading.Thread(target=lambda: box.append(
            ld._wait_parent_gone_nt(4242, fd=r, wait_pid=block, peek=posix_peek)), daemon=True)
        spy.calls = 0
        t.start()
        samples = []
        for _ in range(10):
            time.sleep(0.1)
            samples.append(spy.inside)
        check(not box and spy.calls == 0 and max(samples) == 0,
              "[peek] pipe open and empty → still watching, no read() in progress, none made")
        os.write(w, b"x" * 100)
        time.sleep(ld.PEEK_S * 3)
        check(not box and spy.calls >= 1 and posix_peek(r) == 0,
              "[peek] bytes the app writes are drained and the watch carries on")
        os.close(w)
        t.join(3)
        check(box == ["parent closed stdin"], "[peek] …then EOF still ends it")
        os.close(r)

        r, w = os.pipe()
        threading.Timer(0.3, os.close, args=(w,)).start()
        check(within(3, lambda: ld._wait_parent_gone_nt(4242, fd=r, wait_pid=block, peek=lambda fd: False))
              == "parent closed stdin", "[peek] cannot peek (not a pipe) → blocking read fallback still sees EOF")
        os.close(r)
    finally:
        ld.os = real_os

    r, w = os.pipe()
    check(ld._peek_pipe_nt(r) is False, "[peek] real peek off Windows → 'cannot peek', no exception")
    os.close(r)
    os.close(w)
else:
    print("SKIP [peek] logic part runs on a POSIX box (FIONREAD); the real part below covers Windows")

# ── 2. Windows: the watch running, then a native import ──────────────────────
CHILD = r"""
import os, sys, threading, time
sys.path.insert(0, sys.argv[1])
import local_daemon as ld
# A hung child is stuck under the loader lock: os._exit / kill() of the venv launcher
# would leave it behind. TerminateProcess needs no loader lock — resolved up front.
import ctypes
_term = ctypes.WinDLL("kernel32").TerminateProcess
_term.argtypes = [ctypes.c_void_p, ctypes.c_uint]
_dog = threading.Timer(float(sys.argv[3]), lambda: _term(ctypes.c_void_p(-1), 3))
_dog.daemon = True
_dog.start()
if sys.argv[2] == "blocking":
    ld._peek_pipe_nt = lambda fd: False   # the pre-fix watch: a read parked on fd 0
threading.Thread(target=ld._wait_parent_gone, args=(os.getppid(),), daemon=True).start()
time.sleep(1.0)
t = time.time()
import numpy
print("imported %.2f" % (time.time() - t), flush=True)
"""


def run_child(mode, limit):
    """Not communicate(): it closes the child's stdin first, the watch sees EOF
    and stops reading — the very condition under test would never exist."""
    p = subprocess.Popen([sys.executable, "-c", CHILD, RUNTIME, mode, str(limit)], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        t0 = time.time()
        while p.poll() is None and time.time() - t0 < limit + 10:
            time.sleep(0.1)
        if p.poll() is None:
            p.kill()
            p.wait()
            return None, "", ""
        return p.returncode, p.stdout.read().strip(), p.stderr.read().strip()[-300:]
    finally:
        p.stdin.close()


if os.name == "nt":
    try:
        import numpy  # noqa: F401
        have_numpy = True
    except ImportError:
        have_numpy = False
    if not have_numpy:
        check(False, "[windows] numpy is not installed in this interpreter — run this with the engine venv")
    else:
        rc, out, err = run_child("peek", IMPORT_LIMIT_S)
        check(rc == 0 and out.startswith("imported"),
              f"[windows] stdin watch running, stdin pipe held open → `import numpy` finishes "
              f"within {IMPORT_LIMIT_S}s ({out or 'timed out'}{' / ' + err if err else ''})")
        rc, out, _ = run_child("blocking", 15)
        print(f"info [windows] control, watch forced back to a blocking read: "
              f"{out if rc == 0 else 'no import within 15s (the pre-fix hang)'}", flush=True)
else:
    print("SKIP [windows] the real native-import check runs on Windows only")

print(f"{'ALL OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
