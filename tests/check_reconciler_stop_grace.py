"""Desktop stop while an order leg is out (desktop 0.1.58, spec §2.6, acceptance 25 and 27).

runtime/local_daemon.run_reconciler's exit path: an order leg in flight (lib/portfolio's
"<symbol>#market" marker, lib/execute.sync_leg_active) finishes first and clears its own marker;
the leg wait and the exit sweep share the one SWEEP_BUDGET_S, so the process is gone inside the
daemon's STOP_GRACE_S either way. A leg that does not come back within the budget leaves its
marker, and the next start's reap pauses trading on it. POSIX: SIGTERM on the main thread, the
handler returns so the leg can finish. Windows: the parent watch calls the same exit off the main
thread (emulated here by calling the installed handler from a thread). An old lib/execute (no
sync_leg_active) leaves exactly as before.

Real processes, a fake manager/reconciler.py and a fake leg; no venue, no network.
Run: cd blave-agent && .venv/bin/python tests/check_reconciler_stop_grace.py
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="stop-grace-")
fails = 0

sys.path.insert(0, os.path.join(ROOT, "runtime"))
import local_daemon as ld  # noqa: E402


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


FAKE = r'''
import os, signal, sys, threading, time
from lib import execute
mode, leg = os.environ["LEG_MODE"], float(os.environ["LEG_S"])
if mode == "old":
    del execute.sync_leg_active
if mode == "win":
    threading.Timer(0.5, signal.getsignal(signal.SIGTERM)).start()   # the Windows parent watch
execute._write_inflight_marker("BTCUSDT#market", "market", 10)
open("ready", "w").write("1")
t0 = time.monotonic()
while time.monotonic() - t0 < leg:   # the order leg, on the main thread
    time.sleep(0.05)
execute._remove_inflight_marker("BTCUSDT#market")
open("leg_done", "w").write("1")
time.sleep(30)
'''


def run(mode, leg_s):
    ws = tempfile.mkdtemp(prefix=f"{mode}-", dir=BASE)
    shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(ws, "lib"), ignore=shutil.ignore_patterns("__pycache__"))
    os.makedirs(os.path.join(ws, "manager"))
    os.makedirs(os.path.join(ws, "state"))
    open(os.path.join(ws, "manager", "reconciler.py"), "w").write(FAKE)
    json.dump({"self_ledger": True}, open(os.path.join(ws, "manager", "portfolio_config.json"), "w"))
    env = dict(os.environ, LEG_MODE=mode, LEG_S=str(leg_s), BLAVE_AGENT_HOME=ws, BLAVE_AGENT_WORKSPACE=ws)
    env.pop("BLAVE_AGENT_LOCAL", None)
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "runtime", "local_daemon.py"), "--run-reconciler",
                          os.path.join("manager", "reconciler.py")], cwd=ws, env=env, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    deadline = time.time() + 30
    while not os.path.exists(os.path.join(ws, "ready")) and time.time() < deadline and p.poll() is None:
        time.sleep(0.05)
    time.sleep(0.5 if mode != "win" else 0.0)
    t0 = time.monotonic()
    if mode != "win":
        p.send_signal(signal.SIGTERM)
    try:
        p.wait(ld.STOP_GRACE_S + 5)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    took = time.monotonic() - t0
    left = os.path.exists(os.path.join(ws, "state", "execution", "inflight", "BTCUSDT_market.json"))
    out = p.stdout.read().decode("utf-8", "replace")
    return took, left, os.path.exists(os.path.join(ws, "leg_done")), p.returncode, ws, out


def halts_next_start(ws):
    code = ("import json,os,sys; sys.path.insert(0,'.'); from lib import execute; execute._notify_fn=lambda m:None\n"
            "n=execute.reap_dead_inflight(); print(json.dumps([n, os.path.exists('state/HALT')]))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ws, capture_output=True, text=True, timeout=60)
    return json.loads(out.stdout.strip().splitlines()[-1])


for mode in ("posix", "win"):
    took, left, done, rc, ws, out = run(mode, 1.0)
    check(done and not left and rc == 0 and took < ld.SWEEP_BUDGET_S + 0.5,
          f"25 {mode}: stop mid-leg, the 1 s leg finishes, marker cleared, gone in {took:.1f}s (rc {rc})"
          + ("" if done else f"\n{out[-800:]}"))
    check(halts_next_start(ws) == [0, False], f"25 {mode}: next start does not pause trading")
    took, left, done, rc, ws, out = run(mode, 10.0)
    check(not done and left and rc == 0 and ld.SWEEP_BUDGET_S - 0.5 < took < ld.STOP_GRACE_S,
          f"25 {mode}: a 10 s leg: gone after the {ld.SWEEP_BUDGET_S}s budget ({took:.1f}s), inside "
          f"STOP_GRACE_S, marker kept (rc {rc})" + ("" if left else f"\n{out[-800:]}"))
    check(halts_next_start(ws) == [1, True], f"25 {mode}: next start pauses trading on that marker")

took, left, done, rc, ws, out = run("old", 10.0)
check(rc == 0 and not done and took < 1.5 and "Traceback" not in out,
      f"27 old lib/execute (no sync_leg_active): leaves at once as before, no error ({took:.1f}s)")

shutil.rmtree(BASE, ignore_errors=True)
print("PASS" if not fails else f"FAILED ({fails})")
sys.exit(1 if fails else 0)
