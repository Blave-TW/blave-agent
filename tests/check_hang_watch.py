"""The runtime's hang watch (desktop 0.1.58, spec live-order-hang-wake-0158 §2.2–2.8).

A reconciler whose progress stamp (state/heartbeat/reconciler_progress, its own pid inside) has not
moved for HANG_STALL_S is killed — the desktop supervisor's own child (tick), on the cloud the pid
the service runs (command_listener._hang_watch_loop) — and the existing supervisor respawns it.
Protects (acceptance numbers):
  1–5   kill at 241 s, not at 239 s; never a pid whose stamp is not its own (an old reconciler);
        a new pid or a wake gets the full threshold; the desktop child is respawned by tick
  7, 10 not wanted / service not active / stop mark newer / restart record / update hold → no kill
  8, 9  a stop or an unbind holds the same lock: no kill inside it, nothing started by the watch
  10a   the cloud watch thread never starts in desktop mode; the lock is reentrant
  20–23 3rd kill within the hour trips HALT (hang_watch) first, 4th and later are left alone (the
        count is on disk), an unwritable HALT means no kill
  24    start_reconciler.sh sends no "System restarted" after a recent hang kill, does after an old one
  28–29 sign of life = newer of heartbeat and stamp: report alive, resume does not restart

Run: cd blave-agent && .venv/bin/python tests/check_hang_watch.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="hang-watch-")
WS = os.path.join(BASE, "workspace")
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.makedirs(os.path.join(WS, "state", "heartbeat"))
os.makedirs(os.path.join(WS, "manager"))
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.chdir(WS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import hang_watch as hw  # noqa: E402
import command_listener as cl  # noqa: E402
import local_daemon as ld  # noqa: E402
import reconciler_presence as rp  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


STAMP = os.path.join(WS, hw.PROGRESS)
HB = os.path.join(WS, "state", "heartbeat", "reconciler")
clock = [1_800_000_000.0]


def stamp(pid, age, ppid=None, at=None):
    with open(STAMP, "w") as f:
        json.dump(dict({"pid": pid, "v": 1}, **({"ppid": ppid} if ppid else {}), **({"at": at} if at else {})), f)
    os.utime(STAMP, (clock[0] - age, clock[0] - age))


def reset_records():
    for p in (hw.RECORD, hw.KILLS, "state/HALT", cl.RESTART_STOP_PATH, cl.RECONCILER_STOP_MARK,
              "state/execution/hold"):
        try:
            os.remove(os.path.join(WS, p))
        except OSError:
            pass


def stall_after(pid, seen_ago, steps=None):
    w = hw.Watch(WS, clock=lambda: clock[0])
    t_end = clock[0]
    clock[0] = t_end - seen_ago
    w.stall(pid)
    while clock[0] < t_end:
        clock[0] = min(t_end, clock[0] + 5)
        out = w.stall(pid)
    return w, out


# ── 2–5: the stall clock ──────────────────────────────────────────────────────────────────────
stamp(4242, 241)
_, s = stall_after(4242, 1000)
check(s is not None and 240 < s < 242, f"1 stamp 241 s old, pid seen long ago: stalled ({s})")
stamp(4242, 239)
_, s = stall_after(4242, 1000)
check(s is not None and s < hw.HANG_STALL_S, f"2 stamp 239 s old: under the threshold ({s})")
stamp(4242, 241)
_, s = stall_after(4343, 1000)
check(s is None, "3 stamp names another pid (an old reconciler, or a leftover): not watched")
os.remove(STAMP)
_, s = stall_after(4242, 1000)
check(s is None, "3 no stamp at all (a reconciler from before 0.1.58): not watched")
stamp(4242, 3 * 3600)
_, s = stall_after(4242, 120)
check(s is not None and s <= 120, f"4 new pid first seen 120 s ago, old stamp: only 120 s counted ({s})")
# 5: the watcher itself slept 2 h (wall clock jumped), the stamp is from before the sleep
w = hw.Watch(WS, clock=lambda: clock[0])
stamp(4242, 0)
w.stall(4242)
clock[0] += 2 * 3600
s1 = w.stall(4242)
for _ in range(47):
    clock[0] += 5
    s2 = w.stall(4242)
check(s1 == 0 and s2 == 235, f"5 after a 2 h jump the full 240 s run from the wake ({s1}, {s2})")
clock[0] += 10
check(w.stall(4242) > hw.HANG_STALL_S, "5 …and still no progress after that is a stall")
clock[0] -= 3600
check(w.stall(4242) == 0, "a clock set backwards reads as fresh, never as a stall")
clock[0] += 3600

# ── desktop: ReconcilerSupervisor.tick ─────────────────────────────────────────────────────────
class FakeProc:
    def __init__(self, pid):
        self.pid, self.returncode, self.stdin, self.killed = pid, None, None, 0

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed += 1
        self.returncode = -9


def supervisor(pid, stall_s, seen_ago=1000):
    sup = ld.ReconcilerSupervisor(WS, lambda **kw: {}, lambda pid: "", lambda **kw: kw)
    sup._note = lambda msg: None
    sup._proc, sup._wanted = FakeProc(pid), True
    stamp(pid, stall_s)
    t_end = clock[0]
    clock[0] = t_end - seen_ago
    sup._hang = hw.Watch(WS, clock=lambda: clock[0])
    sup._hang.stall(pid, key=sup._proc)
    while clock[0] < t_end - 1:
        clock[0] += 1
        sup._hang.stall(pid, key=sup._proc)
    clock[0] = t_end
    return sup


reset_records()
sup = supervisor(5001, 241)
spawned = []
sup._spawn_locked = lambda confirm=True: (spawned.append(1), setattr(sup, "_proc", FakeProc(5002)))[0] and None
p = sup._proc
sup.tick()
check(p.killed == 1 and sup._wanted is True, "1 desktop: stalled child killed once, still wanted")
rec = json.load(open(os.path.join(WS, hw.RECORD)))
check(rec.get("pid") == 5001 and rec.get("halt") is False, f"1 desktop: kill record written first ({rec})")
sup.tick()
check(sup._respawn_at is not None and not spawned, "1 desktop: tick's exit branch schedules the respawn")
sup._respawn_at = time.time() - 1   # RESTART_DELAY_S later
sup.tick()
check(spawned == [1] and sup._proc.pid == 5002, "1 desktop: respawned by the existing supervisor path")

# S1: a kill does not end the process at once (TerminateProcess is asynchronous, a process stuck in
# kernel I/O): the same hang is counted once, however many ticks see it still alive
reset_records()
sup = supervisor(5001, 241)
p = sup._proc
p.kill = lambda: setattr(p, "killed", p.killed + 1)   # still alive after the kill
for _ in range(5):
    clock[0] += 1
    sup.tick()
check(p.killed == 1 and len(hw.recent_kills(WS, clock[0])) == 1,
      f"S1 desktop: still alive after the kill, 5 more ticks: killed and counted once ({p.killed}, {hw.recent_kills(WS, clock[0])})")
sup2 = supervisor(5001, 241)   # a new child that happens to get the same pid: watched from scratch
sup2._hang = sup._hang
sup2._hang.stall(5001, key=sup2._proc)
sup2.tick()
check(sup2._proc.killed == 0, "S2 desktop: same pid, new child: its own full threshold, not killed at once")

reset_records()
sup = supervisor(5001, 239)
sup.tick()
check(sup._proc.killed == 0, "2 desktop: 239 s: not killed")
sup = supervisor(5001, 241)
stamp(4999, 241)
sup.tick()
check(sup._proc.killed == 0, "3 desktop: stamp of another pid: not killed")
sup = supervisor(5001, 241)
sup._wanted = False
sup.tick()
check(sup._proc.killed == 0, "7 desktop: not wanted (stopped): not killed")
sup = supervisor(5001, 241)
with sup._idle_lock:
    sup.tick()
check(sup._proc.killed == 0, "7 desktop: respawn_when_idle holds its lock: not killed")
sup = supervisor(5001, 241)
os.makedirs(os.path.join(WS, "state", "execution"), exist_ok=True)
open(os.path.join(WS, "state", "execution", "hold"), "w").write(str(os.getpid()))
sup.tick()
check(sup._proc.killed == 0, "7 desktop: a fresh update hold: not killed")
os.remove(os.path.join(WS, "state", "execution", "hold"))

# Windows desktop: the daemon's child is the venv launcher; the reconciler is ITS child (stamp ppid).
# Before the kill, the kernel's view of that pid must match: parent = our launcher, created after
# the launcher, a python image, created just before the stamp's `at`. Anything else: no kill.
real_nt, real_kill, real_info, os_kills = ld._nt, ld.os.kill, ld._win_proc_info, []
T0 = 1_700_000_000.0
procs = {}
ld._nt = lambda: True
ld.os.kill = lambda pid, sig: os_kills.append((pid, sig))
ld._win_proc_info = lambda pid: procs.get(pid)


def win_case(child, at=T0 + 5, ppid_in_stamp=5100):
    del os_kills[:]
    reset_records()
    procs.clear()
    procs[5100] = (1, T0 - 1, "python.exe")      # the launcher
    if child:
        procs[5101] = child
    sup = supervisor(5100, 241)
    stamp(5101, 241, ppid=ppid_in_stamp, at=at)
    sup.tick()
    return sup


try:
    sup = win_case((5100, T0, "python.exe"))
    rec = json.load(open(os.path.join(WS, hw.RECORD)))
    check(os_kills == [(5101, ld.signal.SIGTERM)] and sup._proc.killed == 1 and rec.get("pid") == 5101,
          f"Windows desktop: confirmed child of our launcher → the reconciler itself is terminated, then the launcher ({os_kills})")
    for why, kw in (("its parent is not our launcher (pid reused)", dict(child=(4000, T0, "python.exe"))),
                    ("created before our launcher (pid reused)", dict(child=(5100, T0 - 100, "python.exe"))),
                    ("not a python image", dict(child=(5100, T0, "notepad.exe"))),
                    ("created after the stamp was written (a newer process on that pid)", dict(child=(5100, T0 + 30, "python.exe"))),
                    ("the stamp is from long after this process started", dict(child=(5100, T0, "python.exe"), at=T0 + 600)),
                    ("the stamp has no start time", dict(child=(5100, T0, "python.exe"), at=None)),
                    ("the pid cannot be read", dict(child=None)),
                    ("the stamp's ppid is not our child", dict(child=(5100, T0, "python.exe"), ppid_in_stamp=5999))):
        sup = win_case(**kw)
        check(os_kills == [] and sup._proc.killed == 0, f"Windows desktop: {why}: not killed")
    ld._nt = lambda: False
    del os_kills[:]
    sup = supervisor(5100, 241)
    stamp(5101, 241, ppid=5100, at=T0 + 5)
    sup.tick()
    check(os_kills == [] and sup._proc.killed == 0, "macOS: a ppid match alone is not enough (the child is the reconciler)")
finally:
    ld._nt, ld.os.kill, ld._win_proc_info = real_nt, real_kill, real_info

# 8 desktop: a stop that lands while the watch decides — same lock, so after it: not wanted, no respawn
reset_records()
sup = supervisor(5001, 241)
p = sup._proc
sup._stop_locked = lambda why: (setattr(sup, "_proc", None), True)[1]
t = threading.Thread(target=lambda: sup.stop_reconciler("user"))
with sup._lock:   # the watch holds it: the stop waits
    t.start()
    time.sleep(0.1)
    check(t.is_alive(), "8 desktop: stop waits for the watch's lock")
    sup._hang_check_locked(p)
t.join(5)
sup.tick()
check(p.killed == 1 and sup._wanted is False and sup._proc is None and sup._respawn_at is None,
      "8 desktop: killed, then the stop: not wanted, nothing respawned")

# ── 20–23: the count across the hour ──────────────────────────────────────────────────────────
reset_records()
log, killed, halts = [], [], []
for n in range(1, 6):
    out = hw.act(WS, 6000 + n, killed.append, lambda: halts.append(1), log.append, now=clock[0] + n)
    rec = json.load(open(os.path.join(WS, hw.RECORD)))
    if n <= 2:
        check(out == "kill" and rec["halt"] is False and not halts, f"20 kill #{n}: killed, no HALT")
    elif n == 3:
        check(out == "halt" and rec["halt"] is True and halts == [1] and killed[-1] == 6003,
              "20 kill #3 within the hour: HALT tripped first, then killed")
    else:
        check(out == "skip" and killed[-1] == 6003, f"22 hang #{n} within the hour: left alone")
check(len(json.load(open(os.path.join(WS, hw.KILLS)))["at"]) == 3, "22 the count is on disk (a listener restart keeps it)")
check(hw.act(WS, 7000, killed.append, lambda: None, log.append, now=clock[0] + 3700) == "kill",
      "an hour later the count starts over")
reset_records()
for n in range(2):
    hw.act(WS, 6100 + n, lambda pid: None, lambda: None, log.append, now=clock[0])
killed = []


def no_disk():
    raise OSError(28, "No space left on device")


out = hw.act(WS, 6200, killed.append, no_disk, log.append, now=clock[0])
check(out == "halt_failed" and killed == [], "23 3rd hang and HALT cannot be written: not killed")
w23 = hw.Watch(WS, clock=lambda: clock[0])
w23.handled(6200, out)
t23 = clock[0]
clock[0] += hw.HALT_RETRY_S + 1
check(not w23.left_alone(6200), "S11 a HALT that could not be written is tried again a minute later")
clock[0] = t23

# a kill that raises (no right to the process) is not counted and leaves no record
reset_records()
hw.act(WS, 6300, lambda pid: None, lambda: None, log.append, now=clock[0])


def denied(pid):
    raise PermissionError(1, "Operation not permitted")


out = hw.act(WS, 6301, denied, lambda: None, log.append, now=clock[0])
check(out == "kill_failed" and len(hw.recent_kills(WS, clock[0])) == 1 and not os.path.exists(os.path.join(WS, hw.RECORD)),
      "a kill that raises: not counted, no kill record left for a next reconciler")
reset_records()
for n in range(2):
    hw.act(WS, 6400 + n, lambda pid: None, lambda: None, log.append, now=clock[0])
audits = []
out = hw.act(WS, 6402, denied, lambda: True, log.append, now=clock[0], audit=lambda e, **kw: audits.append((e, kw)))
check(out == "kill_failed" and [a[0] for a in audits] == ["hang_kill_failed"] and audits[0][1].get("halt") is True,
      f"3rd hang, HALT tripped, the kill raised: one audit row (no reconciler_hang_halted will follow) ({audits})")

# ── cloud: command_listener._hang_watch_tick ──────────────────────────────────────────────────
calls = []
state = {"active": True, "pids": [8001]}
cl._reconciler_service_active = lambda: calls.append("is-active") or state["active"]
cl._unsupervised_reconciler_pids = lambda proc="/proc", all_=False: list(state["pids"])
kills = []
cl._kill_hung = kills.append
real_run = cl.subprocess.run


def cloud(pid=8001, stall_s=241):
    reset_records()
    with open(os.path.join(WS, cl.RECONCILER_SINGLETON), "w") as f:
        f.write(str(pid))
    stamp(pid, stall_s)
    w = hw.Watch(WS, clock=lambda: clock[0])
    t_end = clock[0]
    clock[0] = t_end - 1000
    w.stall(pid)
    while clock[0] < t_end - 5:
        clock[0] += 5
        w.stall(pid)
    clock[0] = t_end
    return w


def run_tick(w):
    del kills[:]
    cl._hang_watch_tick(w)
    return list(kills)


check(run_tick(cloud()) == [8001], "1 cloud: stalled service reconciler killed (SIGKILL / TerminateProcess)")
check(not any("start" in c for c in calls), "1 cloud: the watch starts nothing (the wrapper loop respawns)")
check(run_tick(cloud(stall_s=239)) == [], "2 cloud: 239 s: not killed")
w = cloud()
with open(os.path.join(WS, cl.RECONCILER_SINGLETON), "w") as f:
    f.write("9999")
check(run_tick(w) == [], "3 cloud: state/reconciler.pid names another pid: not killed")
w = cloud()
state["pids"] = []
check(run_tick(w) == [], "3 cloud: no such reconciler in the process list: not killed")
state["pids"] = [8001]
w = cloud()
state["active"] = False
check(run_tick(w) == [], "7 cloud: service not active (stopped, or a tmux machine): not killed")
state["active"] = True
w = cloud()
open(cl.RECONCILER_STOP_MARK, "w").write("1")
os.utime(cl.RECONCILER_STOP_MARK, (clock[0], clock[0]))
check(run_tick(w) == [], "7 cloud: a stop mark newer than the stamp: not killed")
w = cloud()
open(cl.RESTART_STOP_PATH, "w").write("{}")
check(run_tick(w) == [], "7 cloud: machine-restart record: not killed")
w = cloud()
os.makedirs(os.path.join(WS, "state", "execution"), exist_ok=True)
open(os.path.join(WS, "state", "execution", "hold"), "w").write("1")
check(run_tick(w) == [], "7 cloud: a fresh update hold: not killed")

# 20 cloud: the third kill trips the HALT with source hang_watch through the workspace lib
w = cloud()
hw.act(WS, 1, lambda p: None, lambda: None, print, now=clock[0])
hw.act(WS, 2, lambda p: None, lambda: None, print, now=clock[0])
with open(os.path.join(WS, cl.RECONCILER_SINGLETON), "w") as f:
    f.write("8001")
check(run_tick(w) == [8001], "20 cloud: 3rd kill goes")
h = json.load(open(os.path.join(WS, "state", "HALT")))
check(h.get("source") == "hang_watch" and h.get("reason") == hw.HALT_REASON, f"20 cloud: HALT source hang_watch ({h})")
w = cloud()
hw.act(WS, 1, lambda p: None, lambda: None, print, now=clock[0])
hw.act(WS, 2, lambda p: None, lambda: None, print, now=clock[0])
with open(os.path.join(WS, cl.RECONCILER_SINGLETON), "w") as f:
    f.write("8001")
json.dump({"ts": "x", "reason": "user request", "source": "web"}, open(os.path.join(WS, "state", "HALT"), "w"))
check(run_tick(w) == [8001] and json.load(open(os.path.join(WS, "state", "HALT"))).get("source") == "web"
      and json.load(open(os.path.join(WS, hw.RECORD))).get("halt") is False,
      "20 cloud: a pause already on (the user's) keeps its source on the 3rd kill, and the record does not claim the halt")
w = cloud()
cl._kill_hung = denied
run_tick(w)
cl._kill_hung = kills.append
check(w.left_alone(8001) and run_tick(w) == [], "a kill that raised: that pid is left alone, not retried every 5 s")
clock[0] += hw.STREAK_WINDOW_S + 1
check(not w.left_alone(8001), "S11 …but only for the window: an hour later it is judged again")
w = cloud()
run_tick(w)
check(run_tick(w) == [] and len(hw.recent_kills(WS, clock[0])) == 1,
      "S1 cloud: the killed pid still in the process list on the next check: not counted again")

# 8 cloud: the watch holds _reconciler_ctl_lock while it kills; a stop waits, then runs, nothing restarts
w = cloud()
gate, order = threading.Event(), []
cl._kill_hung = lambda pid: (order.append("kill"), gate.wait(5))
fake_runs = []
cl.subprocess.run = lambda argv, **kw: (fake_runs.append(argv),
                                        subprocess.CompletedProcess(argv, 1, b"", b""))[1]
cl._purge_deployment_registry = lambda names: None
t = threading.Thread(target=lambda: cl._hang_watch_tick(w))
t.start()
time.sleep(0.2)
s = threading.Thread(target=lambda: order.append(("stop", cl._stop_reconciler())))
s.start()
time.sleep(0.2)
check(order == ["kill"], "8 cloud: a stop issued mid-kill waits for the lock")
gate.set()
t.join(5)
s.join(5)
check(order[0] == "kill" and order[1][0] == "stop",
      f"8 cloud: kill, then the stop ({order})")
check(not any("start" in a or "restart" in a for argv in fake_runs for a in argv),
      f"8 cloud: nothing was started ({fake_runs})")
cl.subprocess.run = real_run
cl._kill_hung = kills.append

# 9 cloud: an unbind holds the lock from its stop through the membership clear
w = cloud()
del kills[:]
seen = {}


def stop_during_unbind():
    t = threading.Thread(target=lambda: cl._hang_watch_tick(w))
    t.start()
    t.join(0.5)
    seen["blocked"] = t.is_alive() and not kills
    seen["thread"] = t
    return True


open(os.path.join(WS, ".env"), "w").write("BINANCE_API_KEY=k\nBINANCE_SECRET_KEY=s\n")
real = {n: getattr(cl, n) for n in ("_stop_reconciler", "_sync_strategy_crons", "_mark_reconciler_stopped",
                                     "_reset_unbound_books", "_drop_account_state", "_write_ui_cred_manifest")}
cl._stop_reconciler = stop_during_unbind
cl._sync_strategy_crons = lambda names: None
cl._mark_reconciler_stopped = lambda: seen.setdefault("marked_with_lock_free", not kills)
cl._reset_unbound_books = lambda unbound: False
cl._drop_account_state = lambda *a, **k: None
cl._write_ui_cred_manifest = lambda lines: None
try:
    cl._cmd_credentials_remove({"env": ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"], "clear_book": True})
finally:
    for n, f in real.items():
        setattr(cl, n, f)
seen["thread"].join(5)
check(seen.get("blocked") is True and seen.get("marked_with_lock_free") is True and kills == [8001],
      f"9 cloud: no kill between the unbind's stop and its membership clear; the watch goes after ({seen}, {kills})")

# 10a: no cloud watch thread in desktop mode; the lock is reentrant
import inspect  # noqa: E402
src = inspect.getsource(cl._scheduler_loop)
_gate = 'if not _local_mode() and platform.system() != "Windows":'
check(_gate in src and src.index(_gate) < src.index("_hang_watch_loop"),
      "10a desktop mode never starts _hang_watch_loop (one watch: the supervisor's tick); cloud Windows stays off")
cl._stray_reconciler_pids = lambda: []
cl._reconciler_supervised = lambda: None
for _p in (STAMP, HB):
    if os.path.exists(_p):
        os.remove(_p)
real_rr = cl._restart_reconciler
inner = getattr(real_rr, "__wrapped__", None)
done = []
cl._bound_venue = lambda: False
os.remove(os.path.join(WS, ".env")) if os.path.exists(os.path.join(WS, ".env")) else None
t = threading.Thread(target=lambda: done.append(cl._ensure_reconciler_running()))
t.start()
t.join(5)
check(done and "no venue bound" in done[0] and inner is not None,
      f"10a _ensure_reconciler_running → _restart_reconciler under the same lock: no deadlock ({done})")

# ── 28–29: sign of life ───────────────────────────────────────────────────────────────────────
now = time.time()
open(HB, "w").close()
os.utime(HB, (now - 400, now - 400))
stamp(8001, 0)
os.utime(STAMP, (now - 30, now - 30))
check(abs(rp.last_sign_of_life(os.path.join(WS, "state")) - (now - 30)) < 1, "28 newer of heartbeat and stamp")
import portfolio_reporter as pr  # noqa: E402
reset_records()
r = pr.build_report()["reconciler"]
check(r["alive"] is True and abs(r["heartbeat_at"] - (now - 30)) < 1,
      f"28 report: heartbeat 400 s old, stamp 30 s → alive ({r})")
os.remove(STAMP)
r = pr.build_report()["reconciler"]
check(r["alive"] is False, f"28 report: no stamp → the heartbeat alone, as before ({r})")
stamp(8001, 0)
os.utime(STAMP, (now - 30, now - 30))
cl._clock = time.time
cl._stray_reconciler_pids = lambda: []
cl._restart_reconciler = lambda args: "reconciler restarted"
check(cl._ensure_reconciler_running() == "reconciler already running",
      "29 resume: heartbeat old, stamp fresh → already running, no restart")
os.remove(STAMP)
check(cl._ensure_reconciler_running() == "reconciler restarted", "29 (control) heartbeat alone 400 s old → restarted")

# ── 24 / 10b: start_reconciler.sh ─────────────────────────────────────────────────────────────
SH_WS = os.path.join(BASE, "shws")
os.makedirs(os.path.join(SH_WS, "manager"))
os.makedirs(os.path.join(SH_WS, "state", "execution"))
shutil.copy(os.path.join(ROOT, "manager", "start_reconciler.sh"), os.path.join(SH_WS, "manager"))
BIN = os.path.join(BASE, "bin")
os.makedirs(BIN)
REAL_PY = sys.executable
with open(os.path.join(BIN, "python3"), "w") as f:
    f.write(f"""#!/bin/bash
if [ "$1" = "manager/reconciler.py" ]; then
  n=$(cat runs 2>/dev/null || echo 0); echo $((n+1)) > runs
  if [ "$n" -ge 1 ]; then kill -TERM $PPID; exit 0; fi
  exit 137
fi
body=$(cat)
case "$body" in
  *make_sender*) echo "NOTIFY $2" >> notified; exit 0;;
  *) printf '%s' "$body" | "{REAL_PY}" "$@";;
esac
""")
with open(os.path.join(BIN, "sleep"), "w") as f:
    f.write("#!/bin/bash\nexit 0\n")
for n in ("python3", "sleep"):
    os.chmod(os.path.join(BIN, n), 0o755)
lib_stub = os.path.join(SH_WS, "lib")
os.makedirs(lib_stub)
open(os.path.join(lib_stub, "__init__.py"), "w").close()
open(os.path.join(lib_stub, "portfolio.py"), "w").write("def load_portfolio_config():\n    return {}\n")


def run_sh(record_age):
    for p in ("runs", "notified", os.path.join("state", "execution", "hang_kill.json")):
        try:
            os.remove(os.path.join(SH_WS, p))
        except OSError:
            pass
    if record_age is not None:
        json.dump({"pid": 1, "at": time.time() - record_age, "halt": False},
                  open(os.path.join(SH_WS, "state", "execution", "hang_kill.json"), "w"))
    env = dict(os.environ, PATH=BIN + os.pathsep + os.environ["PATH"])
    subprocess.run(["/bin/bash", os.path.join(SH_WS, "manager", "start_reconciler.sh")], cwd=SH_WS, env=env,
                   capture_output=True, timeout=60)
    try:
        return open(os.path.join(SH_WS, "notified")).read()
    except OSError:
        return ""


got = run_sh(60)
check("Auto-trading started" in got and "System restarted" not in got,
      f"24 a hang kill 60 s ago: no 'System restarted' ({got!r})")
got = run_sh(2 * 3600)
check("System restarted (code 137)" in got, f"10b a 2 h old record: 'System restarted' as usual ({got!r})")
got = run_sh(None)
check("System restarted (code 137)" in got, f"24 (control) no record: 'System restarted' ({got!r})")

shutil.rmtree(BASE, ignore_errors=True)
print("PASS" if not fails else f"FAILED ({fails})")
sys.exit(1 if fails else 0)
