"""First bind routes the saved 下單設定 — desktop (BLAVE_AGENT_LOCAL=1) half of
check_first_bind_routing.py, the onboarding's main user.

On the desktop "no reconciler" is answered by the daemon's supervisor (`_LOCAL_HOST.idle_for_sure`,
under its lock), not the process list: idle → routed; not idle, or no host in this process → not
routed (fail-closed). Runtime only, no network; the host is a stub.

Run: cd blave-agent && .venv/bin/python tests/check_first_bind_routing_local.py
"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="first-bind-local-")
os.environ["BLAVE_AGENT_HOME"] = os.environ["BLAVECLAW_HOME"] = BASE
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_LOCAL"] = "1"
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import command_listener as cl  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


class Host:
    def __init__(self, idle):
        self.idle = idle

    def idle_for_sure(self):
        return self.idle


starts = []
cl._stop_reconciler = lambda: True
cl._restart_reconciler = lambda args: starts.append(1) or "reconciler restarted"
cl._sync_strategy_crons = lambda names: None

CFG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")
PAPER = {"PAPER_API_KEY": "paper", "PAPER_SECRET_KEY": "paper", "PAPER_BOUND_TS": "100"}
CRYPTO = 'SYMBOL = "BTCUSDT"\nINTERVAL = "1h"\nfrom lib.data import fetch_kline\n'


def fresh(host):
    shutil.rmtree(os.path.join(WS, "manager"), ignore_errors=True)
    shutil.rmtree(os.path.join(WS, "strategies"), ignore_errors=True)
    for p in (cl.RECONCILER_STOP_MARK, cl.PARKED_ACCOUNT_STATE, os.path.join(WS, "state", "HALT")):
        if os.path.exists(p):
            os.remove(p)
    os.makedirs(os.path.join(WS, "manager"))
    # without it every strategy reads as Type B, which the desktop refuses to save
    shutil.copy(os.path.join(ROOT, "manager", "wait_for_bar.py"), os.path.join(WS, "manager"))
    open(os.path.join(WS, ".env"), "w").write("BLAVE_API_KEY=not-a-real-blave\n")
    os.makedirs(os.path.join(WS, "strategies", "c1"))
    open(os.path.join(WS, "strategies", "c1", "strategy.py"), "w").write(CRYPTO)
    cl._LOCAL_HOST = None
    cl.dispatch({"cmd": "amounts", "args": {"amounts": {"c1": 300000}}})
    cl._LOCAL_HOST = host


def routes():
    return json.load(open(CFG))["exchanges"], json.load(open(MIRROR))["exchanges"]


try:
    check(cl._local_mode(), "harness: desktop mode")
    fresh(Host(True))
    check(routes() == ({"c1": ""},) * 2, "③ before ④ on the desktop: routing stored blank")
    del starts[:]
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(PAPER)}})
    check(routes() == ({"c1": "paper"},) * 2 and cl._routing_block() is None and not starts,
          "supervisor idle: the first paper bind routes it, start allowed, nothing started")
    fresh(Host(False))
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(PAPER)}})
    check(routes() == ({"c1": ""},) * 2, "supervisor not idle (a reconciler wanted / alive): not routed")
    fresh(None)
    cl.dispatch({"cmd": "credentials", "args": {"env": dict(PAPER)}})
    check(routes() == ({"c1": ""},) * 2, "no supervisor in this process: not routed (fail-closed)")
finally:
    os.chdir(ROOT)
    shutil.rmtree(BASE, ignore_errors=True)

print("PASS" if not fails else f"FAIL {fails}")
sys.exit(1 if fails else 0)
