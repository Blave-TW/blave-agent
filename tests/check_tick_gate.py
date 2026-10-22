"""How many Type A/C live ticks start at once (runtime/tick_gate.py, command_listener._run_scheduler_cycle).

  L  limit: min(cores, total RAM // TICK_MB), at least 1 (the 10-11 bench box, 1.9 GB / 2 vCPU,
     gets 2); BLAVE_TICK_CONCURRENCY=<n> overrides, 0 / off turns the gate off, anything else
     falls back to the default with a note.
  C  cap: N strategies, never more than the limit running at once; every one runs exactly once;
     shorter INTERVAL first; within an interval the order rotates cycle to cycle (each name
     leads once in N cycles, none always last).
  Q  a name already queued or running is not queued twice.
  S  a slot is held at most LEASE seconds: a hung tick does not stall the rest; a waiter that
     somehow never reaches the head runs after MAX_WAIT; a cancelled ticket frees the queue.
  T  timing: five 1m ticks at the bench's concurrent wall (7.4 s, scaled 1:100) through a
     2-slot gate all launch within ~15 s of the cycle — far from the :45 late-launch mark.
  P  across cycles: a 1m name queued this cycle starts before 1h names still waiting from the
     last one; a <5m waiter is let through at its release_at (the scheduler's :45) even with
     every slot taken.
  F  failures: a tick thread that cannot start cancels itself and everyone queued behind it
     (the next name starts at once, not after MAX_WAIT); _get_tick_gate raising → gate off,
     ticks still start; Windows reads ullTotalPhys (fake struct) for the total, the smaller of
     ullAvailPhys / ullAvailPageFile for free memory.
  E  per cycle each strategy.py is read at most twice (type split + INTERVAL minutes), and
     the deployment registry takes the same minutes.
  G  the "queued … launched at :SS" log line: written for a <5m tick launched past :45 (judged on
     the launch second, not when the tick finished) or any tick queued ≥ 10 s; at most one line
     an hour per strategy.
  R  the real _run_scheduler_cycle: gate on → cap held, all ticked, 1m before 1h; gate off →
     every tick spawned at once with target=_tick_one, exactly as before (a barrier of N only
     opens if all N run together).

No subprocess, no network, no real workspace.

Run: cd blave-agent && .venv/bin/python tests/check_tick_gate.py
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="tick-gate-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies"):
    os.makedirs(os.path.join(WS, d))
shutil.copy(os.path.join(ROOT, "manager", "wait_for_bar.py"), os.path.join(WS, "manager"))
os.environ.update({"BLAVE_AGENT_BASE": BASE, "BLAVE_AGENT_WORKSPACE": WS})
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.environ.pop("BLAVE_TICK_CONCURRENCY", None)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402
import tick_gate as tg  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    if not cond:
        fails += 1


class Tracker:
    def __init__(self):
        self.lock = threading.Lock()
        self.now = self.peak = 0
        self.order = []

    def body(self, name, secs):
        def fn():
            with self.lock:
                self.order.append(name)
                self.now += 1
                self.peak = max(self.peak, self.now)
            time.sleep(secs)
            with self.lock:
                self.now -= 1
        return fn


def run_cycle(gate, items, secs, tracker):
    threads = []
    for n in gate.enqueue(items):
        t = threading.Thread(target=gate.run, args=(n, tracker.body(n, secs)))
        t.start()
        threads.append(t)
    for t in threads:
        t.join(30)
    return threads


# ── L ──────────────────────────────────────────────────────────────────────────────────────
check(tg.default_limit(1950, 2) == 2, "2 GB / 2 vCPU (the bench box) → 2")
check(tg.default_limit(1000, 2) == 1, "1 GB → 1")
check(tg.default_limit(16384, 8) == 8, "16 GB / 8 cores → 8 (cores bind)")
check(tg.default_limit(None, 4) == 4, "total memory unreadable → cores")
check(tg.default_limit(500, 0) == 1, "never below 1")
check(tg.configured_limit("3", 1950, 2) == (3, None), "BLAVE_TICK_CONCURRENCY=3 overrides the default")
for off in ("0", "off", " OFF ", "Off"):
    check(tg.configured_limit(off, 1950, 2) == (None, None), f"{off!r} → gate off")
for unset in (None, "", "auto"):
    check(tg.configured_limit(unset, 1950, 2) == (2, None), f"{unset!r} → default, no note")
lim, note = tg.configured_limit("lots", 1950, 2)
check(lim == 2 and note and "lots" in note, "unparseable value → default plus a note naming it")
check(tg.configured_limit("-2", 1950, 2)[0] == 2, "negative → default")
mem = cl.refresh_capacity.total_memory_mb()
check(isinstance(mem, int) and mem > 256, f"total_memory_mb reads this machine ({mem} MB)")

# ── C ──────────────────────────────────────────────────────────────────────────────────────
gate, tr = tg.TickGate(3), Tracker()
items = [(f"s{i:02d}", 1 if i % 3 else 60) for i in range(12)]
run_cycle(gate, items, 0.05, tr)
check(tr.peak <= 3, f"12 ticks through a 3-slot gate: at most 3 at once (peak {tr.peak})")
check(sorted(tr.order) == sorted(n for n, _ in items), "every strategy ran exactly once")
mins = dict(items)
check([mins[n] for n in tr.order] == sorted(mins[n] for n in tr.order), "1m strategies started before 1h ones")

gate, firsts, lasts = tg.TickGate(1), [], []
names = [f"r{i}" for i in range(5)]
for _ in range(5):
    tr = Tracker()
    run_cycle(gate, [(n, 1) for n in names], 0.01, tr)
    firsts.append(tr.order[0])
    lasts.append(tr.order[-1])
check(sorted(firsts) == names, f"same interval: each name leads once in 5 cycles ({firsts})")
check(len(set(lasts)) == 5, f"no name is always last ({lasts})")

gate = tg.TickGate(1)
mixed = [("a1m", 1), ("b1m", 1), ("c1h", 60), ("d1h", 60)]
orders = []
for _ in range(4):
    tr = Tracker()
    run_cycle(gate, mixed, 0.01, tr)
    orders.append(tr.order)
check(all(set(o[:2]) == {"a1m", "b1m"} for o in orders), "mixed: the 1m pair always ahead of the 1h pair")
check({o[0] for o in orders} == {"a1m", "b1m"} and {o[2] for o in orders} == {"c1h", "d1h"},
      "mixed: each pair still rotates")

# ── Q ──────────────────────────────────────────────────────────────────────────────────────
gate, hold = tg.TickGate(1), threading.Event()
check(gate.enqueue([("x", 1), ("y", 1)]) == ["x", "y"], "two names queued")
tx = threading.Thread(target=gate.run, args=("x", hold.wait))
tx.start()
time.sleep(0.1)
check(gate.enqueue([("x", 1), ("y", 1), ("z", 1)]) == ["z"],
      "next cycle: x (running) and y (waiting) are not queued again, z is")
hold.set()
ty = threading.Thread(target=gate.run, args=("y", lambda: None))
tz = threading.Thread(target=gate.run, args=("z", lambda: None))
ty.start(); tz.start()
for t in (tx, ty, tz):
    t.join(5)
check(not any(t.is_alive() for t in (tx, ty, tz)), "queue drains after the holder finishes")

# ── S ──────────────────────────────────────────────────────────────────────────────────────
gate, stuck, tr = tg.TickGate(1, lease=0.3), threading.Event(), Tracker()
gate.enqueue([("hung", 1), ("p", 1), ("q", 1)])
th = threading.Thread(target=gate.run, args=("hung", stuck.wait))
th.start()
time.sleep(0.05)
t0 = time.monotonic()
others = [threading.Thread(target=gate.run, args=(n, tr.body(n, 0.01))) for n in ("p", "q")]
for t in others:
    t.start()
for t in others:
    t.join(5)
took = time.monotonic() - t0
check(sorted(tr.order) == ["p", "q"] and th.is_alive(),
      f"a hung tick (still running) frees its slot after the lease: others ran in {took:.2f}s")
check(0.2 <= took < 2, "…not before the lease, not much after")
stuck.set(); th.join(5)

gate, tr = tg.TickGate(2, max_wait=0.4), Tracker()
gate.enqueue([("orphan", 1), ("w", 1)])   # orphan never calls run(): a ticket with no thread
t0 = time.monotonic()
tw = threading.Thread(target=gate.run, args=("w", tr.body("w", 0)))
tw.start(); tw.join(5)
check(tr.order == ["w"] and 0.3 <= time.monotonic() - t0 < 2,
      "a waiter stuck behind a ticket nobody runs goes after MAX_WAIT")
gate.cancel("orphan")
tr = Tracker()
gate.enqueue([("v", 1)])
t0 = time.monotonic()
tv = threading.Thread(target=gate.run, args=("v", tr.body("v", 0)))
tv.start(); tv.join(5)
check(tr.order == ["v"] and time.monotonic() - t0 < 0.3, "after cancel the next one starts at once")
try:
    gate.run("never-queued", lambda: None)
    check(False, "run() of a name never queued raises")
except KeyError:
    check(True, "run() of a name never queued raises")

# ── T ──────────────────────────────────────────────────────────────────────────────────────
SCALE = 100.0
gate = tg.TickGate(2, clock=lambda: time.monotonic() * SCALE)   # lease / max_wait in scaled seconds
starts, lk = {}, threading.Lock()
t0 = time.monotonic()


def scaled(n):
    def fn():
        with lk:
            starts[n] = (time.monotonic() - t0) * SCALE
        time.sleep(7.4 / SCALE)
    return fn


ths = [threading.Thread(target=gate.run, args=(n, scaled(n))) for n in gate.enqueue([(f"m{i}", 1) for i in range(5)])]
for t in ths:
    t.start()
for t in ths:
    t.join(10)
last = max(starts.values())
check(len(starts) == 5 and last < 2 * 7.4 + 10,
      f"five 1m ticks, 2 slots, 7.4 s each: the last launches {last:.1f}s into the cycle "
      f"(fires at :{cl.SCHEDULER_PHASE_SECONDS:02d} → launched by :{cl.SCHEDULER_PHASE_SECONDS + last:04.1f}, "
      f"late mark :{cl.LATE_LAUNCH_SECOND})")
check(cl.SCHEDULER_PHASE_SECONDS + last < cl.LATE_LAUNCH_SECOND, "…well before the late-launch mark")

# ── P ──────────────────────────────────────────────────────────────────────────────────────
gate, hold, tr = tg.TickGate(1), threading.Event(), Tracker()
gate.enqueue([("blk", 1)])
tb = threading.Thread(target=gate.run, args=("blk", hold.wait))
tb.start(); time.sleep(0.05)
ws = [threading.Thread(target=gate.run, args=(n, tr.body(n, 0.01))) for n in gate.enqueue([("h1", 60), ("h2", 60)])]
for t in ws:
    t.start()
time.sleep(0.05)
ws += [threading.Thread(target=gate.run, args=(n, tr.body(n, 0.01))) for n in gate.enqueue([("m1", 1)])]
ws[-1].start(); time.sleep(0.05)
hold.set()
for t in ws + [tb]:
    t.join(5)
check(tr.order[0] == "m1" and sorted(tr.order) == ["h1", "h2", "m1"],
      f"next cycle's 1m starts ahead of last cycle's waiting 1h ({tr.order})")

gate, hold, tr = tg.TickGate(1), threading.Event(), Tracker()
gate.enqueue([("blk", 1), ("late1m", 1)])
tb = threading.Thread(target=gate.run, args=("blk", hold.wait))
tb.start(); time.sleep(0.05)
t0 = time.monotonic()
tl = threading.Thread(target=gate.run, args=("late1m", tr.body("late1m", 0)), kwargs={"release_at": time.time() + 0.3})
tl.start(); tl.join(5)
check(tr.order == ["late1m"] and tb.is_alive() and 0.2 <= time.monotonic() - t0 < 2,
      "a <5m waiter runs at its release_at while the only slot is still held")
hold.set(); tb.join(5)

# ── F ──────────────────────────────────────────────────────────────────────────────────────
real_thread = cl.threading.Thread


class _Flaky(threading.Thread):
    n = 0

    def start(self):
        _Flaky.n += 1
        if _Flaky.n == 2:
            raise RuntimeError("can't start new thread")
        super().start()


gate, tr = tg.TickGate(1), Tracker()
cl._tick_gate, cl._tick_gate_read = gate, True
real_tick = cl._tick_one
cl._tick_one = lambda n: tr.body(n, 0.01)()
cl.threading.Thread = _Flaky
try:
    cl._start_ticks({"fa": 1, "fb": 1, "fc": 1, "fd": 1})
    raised = False
except RuntimeError:
    raised = True
finally:
    cl.threading.Thread = real_thread
time.sleep(0.2)
check(raised and tr.order == ["fa"] and not gate._waiting,
      f"thread start fails on the 2nd: it and everyone behind it are cancelled, the 1st still ran ({tr.order})")
t0 = time.monotonic()
cl._start_ticks({"fe": 1})
for t in threading.enumerate():
    if t.name == "strategy-tick-fe":
        t.join(5)
check("fe" in tr.order and time.monotonic() - t0 < 1, "…and the next cycle's tick starts at once, not after MAX_WAIT")
cl._tick_one = real_tick

real_cfg, logged2, real_log = tg.configured_limit, [], cl._log
tg.configured_limit = lambda *a, **k: (_ for _ in ()).throw(TypeError("ctypes oddity"))
cl._log = logged2.append
cl._tick_gate, cl._tick_gate_read = "stale", False
try:
    g = cl._get_tick_gate()
finally:
    tg.configured_limit, cl._log = real_cfg, real_log
check(g is None and cl._tick_gate_read and any("gate off" in m for m in logged2),
      f"_get_tick_gate raising → gate off, logged, not retried every minute ({logged2})")

rc = cl.refresh_capacity
real_sys, real_ms = rc.platform.system, rc._win_memory_status
GiB = 1024 ** 3
rc.platform.system = lambda: "Windows"
rc._win_memory_status = lambda: type("MS", (), {"ullTotalPhys": 8 * GiB, "ullAvailPhys": 1 * GiB,
                                               "ullAvailPageFile": 3 * GiB})()
try:
    tot, avail = rc.total_memory_mb(), rc.available_memory_mb()
finally:
    rc.platform.system, rc._win_memory_status = real_sys, real_ms
check(tot == 8192 and avail == 1024, f"Windows: total = ullTotalPhys ({tot}), free = min(avail phys, commit left) ({avail})")

# ── R ──────────────────────────────────────────────────────────────────────────────────────
cl._ac_migration_done = True   # never touch this computer's crontab
cl._sync_deployment_registry = cl._prune_deployment_registry = lambda names: None
cl._signals_frozen = lambda: False
strats = {f"one{i}": "1m" for i in range(4)}
strats.update({f"hour{i}": "1h" for i in range(3)})
for n, iv in strats.items():
    os.makedirs(os.path.join(WS, "strategies", n), exist_ok=True)
    with open(os.path.join(WS, "strategies", n, "strategy.py"), "w") as f:
        f.write(f'INTERVAL = "{iv}"\n')
json.dump({"amounts": {n: 100 for n in strats}}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))


class _T(threading.Thread):
    spawned = []

    def start(self):
        _T.spawned.append(self._target)   # Thread drops _target once run() returns
        super().start()


def cycle(tick):
    _T.spawned = []
    real_tick, real_thread = cl._tick_one, cl.threading.Thread
    cl._tick_one, cl.threading.Thread = tick, _T
    try:
        cl._run_scheduler_cycle()
        for t in threading.enumerate():
            if t.name.startswith("strategy-tick-"):
                t.join(30)
    finally:
        cl._tick_one, cl.threading.Thread = real_tick, real_thread
    return _T.spawned


cl._tick_gate, cl._tick_gate_read = tg.TickGate(2, wall=lambda: 0.0), True   # never at :45: the cap alone
tr = Tracker()
cycle(lambda n: tr.body(n, 0.05)())
check(tr.peak <= 2 and sorted(tr.order) == sorted(strats), f"gate on: all 7 ticked, at most 2 at once (peak {tr.peak})")
check([strats[n] for n in tr.order] == sorted(strats.values(), key=lambda v: v != "1m"),
      f"gate on: the 1m strategies first ({tr.order})")

cl._tick_gate, cl._tick_gate_read = None, True
barrier, ran = threading.Barrier(len(strats), timeout=5), []


def together(n):
    barrier.wait()   # BrokenBarrierError unless all 7 are running at the same time
    ran.append(n)


spawned = cycle(together)
check(sorted(ran) == sorted(strats), "gate off: all 7 ticks run at the same time")
check(len(spawned) == len(strats) and all(t is together for t in spawned),
      "gate off: one thread per name, target = _tick_one itself (unchanged spawn)")

# late-launch log: judged on the launch second, not the finish
logged, real_log, real_time, real_tick = [], cl._log, cl.time, cl._tick_one
wall = [0.0]
cl._log = logged.append
cl.time = type("T", (), {"time": staticmethod(lambda: wall[0])})


def advance(n):
    wall[0] += 40   # the tick itself runs 40 s


cl._tick_one = advance


class StubGate:
    limit = 2

    def __init__(self, launch_wall, waited):
        self.launch_wall, self.waited = launch_wall, waited

    def run(self, name, fn, release_at=None):   # TickGate.run minus the waiting: launch, run, report
        wall[0] = self.launch_wall
        fn()
        return self.waited


M0 = 1792000000.0 - 1792000000.0 % 60
try:
    for launch_at, iv, want in ((10, 1, False), (50, 1, True), (50, 60, False)):
        logged.clear()
        cl._gated_tick(StubGate(M0 + launch_at, 2.0), "late", iv)
        hit = any("launched at :%02d" % launch_at in m for m in logged)
        check(hit == want, f"{iv}m tick queued 2 s, launched at :{launch_at:02d}, finished 40 s later → "
                           f"late-launch line {'written' if want else 'not written'} ({logged})")
    logged.clear()
    cl._gated_tick(StubGate(M0 + 12, 11.0), "slow", 60)
    check(any("queued 11.0s" in m for m in logged), "any tick queued ≥ 10 s is logged")
    logged.clear()
    for k in range(5):
        cl._gated_tick(StubGate(M0 + 60 * (k + 1) + 12, 11.0), "slow", 60)
    cl._gated_tick(StubGate(M0 + 3600 + 72, 11.0), "slow", 60)
    check(len(logged) == 1, f"the same strategy queued every minute: one line, then the next an hour later ({len(logged)})")
finally:
    cl._log, cl.time, cl._tick_one = real_log, real_time, real_tick

# ── E ──
reads, real_src = {}, cl._strategy_source


def counting(name):
    reads[name] = reads.get(name, 0) + 1
    return real_src(name)


reg, real_sync = [], cl._sync_deployment_registry
cl._strategy_source, cl._sync_deployment_registry = counting, reg.append
cl._tick_gate, cl._tick_gate_read = None, True
try:
    cycle(lambda n: None)
finally:
    cl._strategy_source, cl._sync_deployment_registry = real_src, real_sync
check(reads and max(reads.values()) <= 2, f"strategy.py reads per strategy per cycle ≤ 2 ({reads})")
check(reg and reg[0] == {n: (1 if iv == "1m" else 60) for n, iv in strats.items()},
      "the deployment registry gets the same {name: minutes} the gate uses")
cl._sync_deployment_registry = lambda names: None

for env, want in (("off", None), ("0", None), ("2", 2)):
    os.environ["BLAVE_TICK_CONCURRENCY"] = env
    cl._tick_gate, cl._tick_gate_read = None, False
    g = cl._get_tick_gate()
    check((g.limit if g else None) == want, f"BLAVE_TICK_CONCURRENCY={env} → {want}")
os.environ.pop("BLAVE_TICK_CONCURRENCY", None)

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
