"""Contract switch while trading is stopped (design §7, Wei 10-14).

  A  reconciler_absent (cloud): certain only when no reconciler.py is in the
     process list (supervised or not), reconciler.pid's lock is free and no
     workspace update is swapping files; an unreadable list, a held lock or a
     fresh update hold is "maybe there" — fail-closed.
  L  desktop: the daemon's supervisor answers under its own lock — not wanted, no
     live child, its lock and the singleton free.
  C  can_switch_contract: fresh heartbeat → caps; stale/none → absent AND the
     lib on disk; a stale heartbeat with a process maybe there stays false.
  S  saving a switch while stopped works; HALT refuses it only while a
     reconciler may be running.
  G  the start gate: a funded switch in force with a lib on disk that ignores it
     refuses every start (runtime _restart_reconciler, the daemon's spawn).
Real locks are taken by a real child process (fcntl/msvcrt), never faked.

Run: cd blave-agent && .venv/bin/python tests/check_contract_switch_stopped.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="contract-switch-stopped-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state/heartbeat", "state/execution", "lib"):
    os.makedirs(os.path.join(WS, d))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
os.chdir(WS)
import command_listener as cl  # noqa: E402
import local_daemon as ld  # noqa: E402
import portfolio_reporter as pr  # noqa: E402

fails = 0
SINGLETON = os.path.join(WS, "state", "reconciler.pid")
HOLD = os.path.join(WS, "state", "execution", "hold")
HB = os.path.join(WS, "state", "heartbeat", "reconciler")
HALT = os.path.join(WS, "state", "HALT")
CONFIG = os.path.join(WS, "manager", "portfolio_config.json")
MIRROR = os.path.join(WS, "manager", "amounts.ui.json")


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


HOLDER = r"""
import os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
try:
    import fcntl
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except ImportError:
    import msvcrt
    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
print("held", flush=True)
time.sleep(60)
"""


class Holder:
    """A real other process holding the lock on `path` (like a live reconciler)."""

    def __init__(self, path):
        self.p = subprocess.Popen([sys.executable, "-c", HOLDER, path], stdout=subprocess.PIPE, text=True)
        assert self.p.stdout.readline().strip() == "held"

    def release(self):
        self.p.terminate()  # our own child, by handle
        self.p.wait(10)


def lib_disk(new):
    for name in ("portfolio.py", "paper_data.py"):
        dst = os.path.join(WS, "lib", name)
        if new:
            shutil.copy(os.path.join(ROOT, "lib", name), dst)
        else:
            open(dst, "w").write("# an older lib\n")


procs = {"pids": []}
cl._unsupervised_reconciler_pids = lambda proc="/proc", all_=False: procs["pids"]

# ── A: cloud presence ───────────────────────────────────────────────────────
check(cl.lock_file_free(SINGLETON), "A no singleton file = free")
h = Holder(SINGLETON)
check(not cl.lock_file_free(SINGLETON), "A singleton held by a live process = not free")
check(not cl.reconciler_absent(), "A …so not absent")
h.release()
check(cl.lock_file_free(SINGLETON), "A the holder exited (the OS dropped the lock) = free")
check(cl.reconciler_absent(), "A empty process list + free lock + no hold = absent")
procs["pids"] = [4242]
check(not cl.reconciler_absent(), "A a reconciler.py in the process list (e.g. pre-singleton, takes no lock) = not absent")
procs["pids"] = None
check(not cl.reconciler_absent(), "A process list unreadable = not absent")
procs["pids"] = []
open(HOLD, "w").close()
check(not cl.reconciler_absent(), "A a fresh workspace-update hold = not absent")
old = time.time() - cl.UPDATE_HOLD_STALE_S - 60
os.utime(HOLD, (old, old))
check(cl.reconciler_absent(), "A a stale hold (dead update script) does not count")
os.remove(HOLD)

# ── C: can_switch_contract ──────────────────────────────────────────────────


def heartbeat(age=None, caps=False):
    if age is None:
        if os.path.exists(HB):
            os.remove(HB)
    else:
        open(HB, "w").close()
        t = time.time() - age
        os.utime(HB, (t, t))
    doc = {"ts": "x", "target": {}, "actual": {}, "orders": []}
    if caps:
        doc["caps"] = ["contract_override"]
    json.dump(doc, open(os.path.join(WS, "manager", "last_reconcile.json"), "w"))


lib_disk(True)
heartbeat(None)
check(pr.can_switch_contract() is True, "C no process at all + new lib on disk → can switch")
lib_disk(False)
check(pr.can_switch_contract() is False, "C no process + old lib on disk → cannot")
lib_disk(True)
heartbeat(pr.HEARTBEAT_STALE_S + 60, caps=True)
h = Holder(SINGLETON)
check(pr.can_switch_contract() is False, "C stale heartbeat but the singleton is held (stuck / asleep) → fail-closed")
h.release()
procs["pids"] = [4242]
check(pr.can_switch_contract() is False, "C stale heartbeat and a reconciler.py in the list → fail-closed")
procs["pids"] = []
check(pr.can_switch_contract() is True, "C stale heartbeat, provably no process, new lib → can switch")
heartbeat(1, caps=False)
check(pr.can_switch_contract() is False, "C running without caps → cannot (disk not consulted)")
heartbeat(1, caps=True)
check(pr.can_switch_contract() is True, "C running with caps → can")
check(pr.build_report().get("can_switch_contract") is True, "C the report carries it")

# ── S: saving while stopped ─────────────────────────────────────────────────
for n, sym in (("txf_a", "TXF"),):
    d = os.path.join(WS, "strategies", n)
    os.makedirs(d, exist_ok=True)
    json.dump({"symbol": sym}, open(os.path.join(d, "stats.json"), "w"))
    open(os.path.join(d, "strategy.py"), "w").write(f'SYMBOL = "{sym}"\nINTERVAL = "1h"\n')
open(os.path.join(WS, "manager", "wait_for_bar.py"), "w").write("# present\n")
open(os.path.join(WS, ".env"), "w").write("CAPITAL_API_KEY=A123456789\nCAPITAL_PASSWORD=vault:abc\n")
cl._sync_strategy_crons = lambda names: None


def save(amounts, contracts=None):
    args = {"amounts": amounts}
    if contracts is not None:
        args["contracts"] = contracts
    try:
        cl._cmd_amounts(args)
    except (ValueError, RuntimeError) as e:
        return str(e)
    return None


heartbeat(None)
check(save({"txf_a": 1}) is None, "S first save, trading never started")
err = save({"txf_a": 20}, {"txf_a": "TMF"})
check(err is None and json.load(open(CONFIG))["contracts"] == {"txf_a": "TMF"},
      f"S switch saved with no reconciler process ({err})")
save({"txf_a": 1}, {})
open(HALT, "w").close()
err = save({"txf_a": 20}, {"txf_a": "TMF"})
check(err is None, f"S HALT set but no process: the switch saves (start lifts HALT first) ({err})")
save({"txf_a": 1}, {})
heartbeat(1, caps=True)
err = save({"txf_a": 20}, {"txf_a": "TMF"})
check((err or "").startswith("CONTRACT_HALTED:"),
      f"S HALT, running code without the freeze cap: CONTRACT_HALTED ({err})")
doc = json.load(open(os.path.join(WS, "manager", "last_reconcile.json")))
doc["caps"] = ["contract_override", "rollover_halt_freeze"]
json.dump(doc, open(os.path.join(WS, "manager", "last_reconcile.json"), "w"))
err = save({"txf_a": 20}, {"txf_a": "TMF"})
check(err is None and json.load(open(CONFIG))["contracts"] == {"txf_a": "TMF"}
      and json.load(open(os.path.join(WS, "state", "contract_rollover.json")))["txf_a"]["to"] == "TMF",
      f"S HALT, running code that freezes: switch and rollover record saved ({err})")
save({"txf_a": 1}, {})
heartbeat(1, caps=True)
os.remove(HALT)
heartbeat(pr.HEARTBEAT_STALE_S + 60, caps=True)
h = Holder(SINGLETON)
err = save({"txf_a": 20}, {"txf_a": "TMF"})
check((err or "").startswith("CONTRACT_NEEDS_UPDATE:"), f"S stale heartbeat, process maybe there: refused ({err})")
h.release()

# ── G: start gate ───────────────────────────────────────────────────────────
heartbeat(None)
check(save({"txf_a": 20}, {"txf_a": "TMF"}) is None, "G (switch in force)")
check(cl._contracts_start_block() is None, "G new lib on disk: no block")
lib_disk(False)
block = cl._contracts_start_block()
check((block or "").startswith("CONTRACT_NEEDS_UPDATE:") and "txf_a" in block, f"G lib rolled back: start blocked ({block})")
started = []


def _no_start(*a, **k):  # a missing gate must fail here, never start tmux / systemctl / nssm
    started.append(a[:1])
    raise AssertionError("tried to start a reconciler")


real_run, real_popen_cl = cl.subprocess.run, cl.subprocess.Popen
cl.subprocess.run = cl.subprocess.Popen = _no_start
try:
    cl._restart_reconciler({})
    raised = None
except Exception as e:
    raised = str(e)
cl.subprocess.run, cl.subprocess.Popen = real_run, real_popen_cl
check((raised or "").startswith("CONTRACT_NEEDS_UPDATE:") and not started,
      f"G _restart_reconciler refuses before starting anything ({raised}, started {started})")
# HALT kept across a start (restart_reconciler / boot) with a rollover open
lib_disk(True)
open(HALT, "w").close()
ROLLF = os.path.join(WS, "state", "contract_rollover.json")
json.dump({"txf_a": {"from": "TXF", "to": "TMF", "at": "t", "id": "i"}}, open(ROLLF, "w"))
check(cl._contracts_start_block() is None, "G HALT + open rollover + lib that freezes: starts")
p = os.path.join(WS, "lib", "portfolio.py")
src = open(p).read()
open(p, "w").write(src.replace("'rollover_halted'", "'rollover_x'"))
block = cl._contracts_start_block()
check((block or "").startswith("CONTRACT_NEEDS_UPDATE:"),
      f"G HALT + open rollover + lib without the freeze: start blocked (it would close only) ({block})")
open(p, "w").write(src)
os.remove(HALT)
check(cl._contracts_start_block() is None, "G …no HALT: resume lifts it first, nothing to block")
os.remove(ROLLF)
lib_disk(False)
mir = json.load(open(MIRROR))
mir["amounts"]["txf_a"] = 0
json.dump(mir, open(MIRROR, "w"))
check(cl._contracts_start_block() is None, "G the switched strategy at amount 0: nothing to mis-trade, starts")
mir["amounts"]["txf_a"] = 20
json.dump(mir, open(MIRROR, "w"))

# ── L: desktop supervisor ───────────────────────────────────────────────────
spawned = []
sup = ld.ReconcilerSupervisor(WS, lambda **k: dict(os.environ), lambda pid: "", lambda **k: {})
check(sup.idle_for_sure() is True, "L not wanted, no child, both locks free → idle")
h = Holder(os.path.join(WS, ld.RECONCILER_LOCK))
check(sup.idle_for_sure() is False, "L the daemon lock held (an orphan from a previous daemon) → not idle")
h.release()
h = Holder(SINGLETON)
check(sup.idle_for_sure() is False, "L reconciler.pid held (a hand-run reconciler) → not idle")
h.release()
sup._wanted = True
check(sup.idle_for_sure() is False, "L wanted (a crash respawn is due) → not idle")
sup._wanted = False
sup._proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
check(sup.idle_for_sure() is False, "L a live child → not idle")
sup._proc.terminate()
sup._proc.wait(10)
sup._proc = None
os.environ["BLAVE_AGENT_LOCAL"] = "1"
cl._LOCAL_HOST = sup
check(cl.reconciler_absent() is True, "L reconciler_absent asks the daemon in local mode")
cl._LOCAL_HOST = None
check(cl.reconciler_absent() is False, "L local mode without a daemon → not absent")
cl._LOCAL_HOST = sup
real_popen = ld.subprocess.Popen
ld.subprocess.Popen = lambda *a, **k: spawned.append(a) or (_ for _ in ()).throw(AssertionError("spawned"))
try:
    sup._spawn_locked()
    raised = None
except Exception as e:
    raised = str(e)
ld.subprocess.Popen = real_popen
check((raised or "").startswith("CONTRACT_NEEDS_UPDATE:") and not spawned,
      f"L the daemon's spawn (start and crash respawn) refuses a rolled-back lib, nothing spawned ({raised})")
os.environ.pop("BLAVE_AGENT_LOCAL", None)
cl._LOCAL_HOST = None

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
