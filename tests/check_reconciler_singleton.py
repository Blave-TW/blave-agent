"""One reconciler per workspace (order-path audit finding 5, 2026-09-23).

Two real manager/reconciler.py processes started at the same moment on one
workspace: exactly one keeps running, the other exits with DUPLICATE_EXIT
before its first round (no "Reconciler started", no startup sweep). A killed
holder (SIGKILL) leaves no stale lock: the next start runs. Both watchdog
wrappers retry a duplicate quietly instead of sending the restart alert.

No venue is bound in the scratch workspace, so the one that runs idles: no
network, no orders.

Run: cd blave-agent && .venv/bin/python tests/check_reconciler_singleton.py
"""
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="reconciler-singleton-")
WS = os.path.join(BASE, "workspace")
for d in ("lib", "manager"):
    shutil.copytree(os.path.join(ROOT, d), os.path.join(WS, d),
                    ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state"))
ENV = dict(os.environ, BLAVE_AGENT_HOME=BASE, BLAVECLAW_HOME=BASE,
           BLAVE_AGENT_BASE=BASE, BLAVE_AGENT_WORKSPACE=WS)
ENV.pop("BLAVE_AGENT_LOCAL", None)

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


def start(tag):
    log = open(os.path.join(BASE, f"{tag}.log"), "w")
    return subprocess.Popen([sys.executable, os.path.join("manager", "reconciler.py")],
                            cwd=WS, env=ENV, stdout=log, stderr=log)


def log_of(tag):
    return open(os.path.join(BASE, f"{tag}.log")).read()


def settle(procs, seconds=12):
    """Until the heartbeat exists and every duplicate has left, or timeout."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        alive = [p for p in procs if p.poll() is None]
        if len(alive) <= 1 and os.path.exists(os.path.join(WS, "state", "heartbeat", "reconciler")):
            break
        time.sleep(0.2)


procs = []
try:
    dup_exit = int(re.search(r"^DUPLICATE_EXIT = (\d+)$", open(os.path.join(
        ROOT, "manager", "reconciler.py"), encoding="utf-8").read(), re.M).group(1))

    a, b = start("a"), start("b")
    procs += [a, b]
    settle([a, b])
    alive = [p for p in (a, b) if p.poll() is None]
    gone = [p for p in (a, b) if p.poll() is not None]
    check(len(alive) == 1, f"two reconcilers started together: exactly one is running (running: {len(alive)})")
    if len(alive) == 1 and len(gone) == 1:
        tag = "a" if gone[0] is a else "b"
        check(gone[0].returncode == dup_exit,
              f"…the other exited with DUPLICATE_EXIT ({dup_exit}), got {gone[0].returncode}")
        check("Reconciler started" not in log_of(tag) and "orphan sweep" not in log_of(tag),
              "…before its first round and before the startup sweep")
        pid = open(os.path.join(WS, "state", "reconciler.pid")).read().strip()
        check(pid == str(alive[0].pid), "…state/reconciler.pid names the one running")
        c = start("c")
        procs.append(c)
        try:
            c.wait(20)
        except subprocess.TimeoutExpired:
            pass
        check(c.poll() == dup_exit and alive[0].poll() is None,
              "a third start while it runs: refused, the running one untouched")
        alive[0].send_signal(signal.SIGKILL)
        alive[0].wait(10)
        d = start("d")
        procs.append(d)
        deadline = time.time() + 20
        while time.time() < deadline and d.poll() is None and "Reconciler started" not in log_of("d"):
            time.sleep(0.2)
        check(d.poll() is None and "Reconciler started" in log_of("d"),
              "holder SIGKILLed: no stale lock, the next start runs")

    for path, pat in (("manager/start_reconciler.sh",
                       r'if \[ "\$EXIT_CODE" -eq 75 \]; then[^\n]*\n(?:[^\n]*\n){0,3}\s*sleep 10\n\s*continue\n\s*fi\n\s*MSG='),
                      ("manager/start_reconciler_windows.ps1",
                       r'if \(\$ExitCode -eq 75\) \{[^\n]*\n(?:[^\n]*\n){0,3}\s*Start-Sleep -Seconds 10\n\s*continue\n\s*\}\n\s*\$Msg =')):
        src = open(os.path.join(ROOT, path), encoding="utf-8").read()
        check(dup_exit == 75 and re.search(pat, src) is not None,
              f"{path}: a duplicate (exit 75) is retried quietly, before the restart alert")
finally:
    for p in procs:
        if p.poll() is None:
            p.kill()
            p.wait(10)
    shutil.rmtree(BASE, ignore_errors=True)

print("\nFAILED" if fails else "\nall ok")
sys.exit(1 if fails else 0)
