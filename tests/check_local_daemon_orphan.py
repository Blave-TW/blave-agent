"""runtime/local_daemon.py — the app is SIGKILLed: the daemon must leave with it.

The fake parent below is shell/daemon.js in miniature: stdin AND stderr of the
daemon are pipes it holds. SIGKILL it and both break at once — that is the shape
check_local_daemon.py (stderr → /dev/null) never exercised.

  1. stderr → file     : parent SIGKILLed → daemon exits, lock released.
  2. stderr → parent   : same, with the log pipe dead (the 2026-09-21 orphan).
  3. stdin write end also held by a third process (no EOF ever comes) → still
     exits: the getppid() watch does not need the EOF. Once with the log pipe
     alive, once dead.
Run: cd blave-agent && .venv/bin/python tests/check_local_daemon_orphan.py
"""
import fcntl
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAEMON = os.path.join(ROOT, "runtime", "local_daemon.py")
EXIT_WITHIN_S = 10

# argv: daemon.py, stderr mode (file path | "pipe"), hold stdin open elsewhere ("1"/"0")
PARENT = r"""
import os, subprocess, sys, time
daemon, err, hold = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
stderr = subprocess.PIPE if err == "pipe" else open(err, "ab")
p = subprocess.Popen([sys.executable, daemon, "--secret-stdin"], stdin=subprocess.PIPE, stderr=stderr)
p.stdin.write(b"k" * 40 + b"\n")
p.stdin.flush()
holder = 0
if hold:
    fd = p.stdin.fileno()
    holder = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                              pass_fds=[fd], stdin=subprocess.DEVNULL).pid
print(p.pid, holder, flush=True)
time.sleep(300)
"""

fails = 0
started = []  # every pid this file caused to exist


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def lock_free(path):
    fd = os.open(path, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


def scenario(name, err_to_pipe, hold):
    base = tempfile.mkdtemp(prefix="local-daemon-orphan-")
    ws = os.path.join(base, "workspace")
    os.makedirs(os.path.join(ws, "manager"))
    open(os.path.join(ws, "manager", "wait_for_bar.py"), "w").write("")
    env = dict(os.environ, BLAVE_AGENT_BASE=base, BLAVE_AGENT_WORKSPACE=ws, BLAVE_AGENT_LOCAL="1")
    err = "pipe" if err_to_pipe else os.path.join(base, "daemon.err")
    parent = subprocess.Popen([sys.executable, "-c", PARENT, DAEMON, err, "1" if hold else "0"],
                              env=env, stdout=subprocess.PIPE, text=True)
    started.append(parent.pid)
    daemon_pid = holder_pid = 0
    try:
        daemon_pid, holder_pid = (int(x) for x in parent.stdout.readline().split())
        started.extend(p for p in (daemon_pid, holder_pid) if p)
        lock = os.path.join(ws, "state", "local_daemon.lock")
        status = os.path.join(ws, "state", "local_status.json")
        for _ in range(100):
            if os.path.isfile(status):
                break
            time.sleep(0.1)
        check(os.path.isfile(status) and not lock_free(lock), f"[{name}] daemon up and holding the lock")
        parent.kill()
        parent.wait(10)
        t0 = time.time()
        while alive(daemon_pid) and time.time() - t0 < EXIT_WITHIN_S:
            time.sleep(0.2)
        took = time.time() - t0
        check(not alive(daemon_pid), f"[{name}] parent SIGKILLed → daemon gone within {EXIT_WITHIN_S}s ({took:.1f}s)")
        check(lock_free(lock), f"[{name}] lock released — the next app can start its daemon")
    finally:
        for pid in (parent.pid, daemon_pid, holder_pid):
            if pid and alive(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if parent.poll() is None:
            parent.wait(10)
        shutil.rmtree(base, ignore_errors=True)


scenario("stderr→file", err_to_pipe=False, hold=False)
scenario("stderr→dead pipe", err_to_pipe=True, hold=False)
scenario("stdin held elsewhere", err_to_pipe=False, hold=True)
scenario("stdin held elsewhere + dead pipe", err_to_pipe=True, hold=True)

time.sleep(0.5)
left = [p for p in started if alive(p)]
check(not left, f"nothing this check started is still running ({left})")
print("FAILED" if fails else "all ok")
sys.exit(1 if fails else 0)
