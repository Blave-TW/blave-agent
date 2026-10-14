"""`stats_refresh` runs several at once (Wei 10-14; runtime/refresh_capacity.py).

  N  cores: min(4, cores // 2), at least 1; memory: one more starts only when free memory less
     RESERVE_MB less what the running ones may still grow by covers its estimate; free memory
     unreadable → one at a time; nothing running → always one. macOS vm_stat parsing.
  E  estimate: the strategy's own measured peak (.perf_cost.json), else DEFAULT_PEAK_MB; a
     Windows peak is used as measured (the process tree is walked; a failed walk records
     nothing). A real child's peak memory and
     wall time are measured.
  O  order: shortest last run first, never-measured last, ties in the order asked.
  P  parallel: never more at once than the capacity says (re-judged before every start), the
     same strategy never runs twice at once (a second press while queued/running → BUSY), the
     sweep waits for shared runs and shared runs wait for the sweep.

Run: cd blave-agent && .venv/bin/python tests/check_stats_refresh_parallel.py
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
BASE = tempfile.mkdtemp(prefix="refresh-par-")
WS = os.path.join(BASE, "workspace")
for d in ("manager", "state", "strategies"):
    os.makedirs(os.path.join(WS, d))
os.environ.update({"BLAVE_AGENT_BASE": BASE, "BLAVE_AGENT_WORKSPACE": WS, "BLAVE_AGENT_LOCAL": "1"})
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import command_listener as cl  # noqa: E402
import refresh_capacity as rc  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


# ── N ───────────────────────────────────────────────────────────────────────
real_cpu = os.cpu_count
for cores, want in ((None, 1), (1, 1), (2, 1), (4, 2), (8, 4), (32, 4)):
    os.cpu_count = lambda c=cores: c
    check(rc.cpu_slots() == want, f"N {cores} cores → {want} at once (got {rc.cpu_slots()})")
os.cpu_count = real_cpu
R, D = rc.RESERVE_MB, rc.DEFAULT_PEAK_MB
check(rc.may_start(D, [], free_mb=0, slots=1), "N nothing running: one always starts, even with no free memory")
check(not rc.may_start(D, [(D, 0)], free_mb=10**6, slots=1), "N slots reached (cores) → wait")
check(rc.may_start(1000, [(1000, 0)], free_mb=R + 2000, slots=4), "N room for the running one's growth and the next → start")
check(not rc.may_start(1000, [(1000, 0)], free_mb=R + 1999, slots=4), "N one MB short → wait")
check(rc.may_start(1000, [(1000, 600)], free_mb=R + 1400, slots=4),
      "N a running one already at 600 of its 1000 only needs 400 more room")
real_avail = rc.available_memory_mb
rc.available_memory_mb = lambda: None
check(not rc.may_start(10, [(10, 10)], slots=4), "N reader returns None → one at a time")
rc.available_memory_mb = real_avail
got = rc.available_memory_mb()
check(isinstance(got, int) and got > 0, f"N this machine's free memory is readable ({got} MB)")
VM = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                           50000.
Pages speculative:                         4000.
Pages wired down:                         90000.
"""
check(rc._parse_vm_stat(VM) == (10000 + 50000 + 4000) * 16384 // (1024 * 1024),
      f"N vm_stat: free + inactive + speculative pages ({rc._parse_vm_stat(VM)} MB)")
check(rc._parse_vm_stat("garbage") is None, "N vm_stat unreadable → None")
check(rc.win_available_mb(8 << 30, 3 << 30) == 3072 and rc.win_available_mb(2 << 30, 9 << 30) == 2048,
      "N Windows: the smaller of free physical memory and commit left")

# ── E ───────────────────────────────────────────────────────────────────────
sd = os.path.join(WS, "strategies", "e1")
os.makedirs(sd)
check(rc.estimate_mb(sd) == D, "E no record → default estimate")
rc.write_cost(sd, 700, 12.5)
check(rc.estimate_mb(sd) == 700 and rc.last_seconds(sd) == 12.5, "E a recorded peak and duration are used")
rc.write_cost(sd, 900, None)
check(rc.estimate_mb(sd) == 900 and rc.last_seconds(sd) == 12.5, "E a failed run updates the peak, keeps the last good duration")
real_sys = rc.platform.system
rc.platform.system = lambda: "Windows"
rc.write_cost(sd, 50, 1.0)
check(rc.estimate_mb(sd) == 50, "E Windows: a measured peak is used as is (the tree walk measures the real interpreter)")
rc.platform.system = real_sys
rc.write_cost(os.path.join(WS, "strategies", "gone"), 100, 1.0)
check(not os.path.exists(os.path.join(WS, "strategies", "gone")), "E no record written for a deleted strategy")
code = "b = bytearray(300 * 1024 * 1024)\nfor i in range(0, len(b), 4096): b[i] = 1\nimport time; time.sleep(1.5)\n"
r, out, err, secs, peak = cl._run_measured("m1", [sys.executable, "-c", code], dict(os.environ), 60)
check(r == 0 and peak >= 250 and secs >= 1.0, f"E a real child: peak {peak} MB (≥250 of 300 allocated), {secs:.1f}s")
r, *_ = cl._run_measured("m2", [sys.executable, "-c", "import time; time.sleep(30)"], dict(os.environ), 1)
check(r is None, "E past the timeout the child is killed and the run reads as timed out")

# OOM: a refresh child is the kernel's first pick (Linux); the value itself is pinned anywhere
tmpadj = os.path.join(BASE, "oom_{pid}")
real_path = rc.OOM_ADJ_PATH
rc.OOM_ADJ_PATH = tmpadj
rc.demote_oom(4242)
check(open(tmpadj.format(pid=4242)).read() == "1000", "E demote_oom writes 1000 (never 0)")
rc.OOM_ADJ_PATH = real_path
if os.path.exists("/proc/self/oom_score_adj"):
    r, out, *_ = cl._run_measured("oom", [sys.executable, "-c",
                                          "import time; time.sleep(1); print(open('/proc/self/oom_score_adj').read())"],
                                  dict(os.environ), 30)
    check(r == 0 and out.strip() == "1000", f"E Linux: the refresh child runs with oom_score_adj 1000 ({out.strip()})")
else:
    print("SKIP E Linux oom_score_adj of a real child (no /proc here)")

# ── O ───────────────────────────────────────────────────────────────────────
for n, s in (("slow", 300), ("fast", 5), ("mid", 40)):
    os.makedirs(os.path.join(WS, "strategies", n), exist_ok=True)
    rc.write_cost(os.path.join(WS, "strategies", n), 500, s)
for n in ("new1", "new2"):
    os.makedirs(os.path.join(WS, "strategies", n), exist_ok=True)
order = [n for n, _ in cl._refresh_order([(n, None) for n in ("new1", "slow", "fast", "new2", "mid")])]
check(order == ["fast", "mid", "slow", "new1", "new2"], f"O shortest first, never-measured last in asked order ({order})")

# ── P ───────────────────────────────────────────────────────────────────────
NAMES = [f"p{i}" for i in range(7)]
for n in NAMES:
    d = os.path.join(WS, "strategies", n)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "strategy.py"), "w").write('INTERVAL = "1h"\nSYMBOL = "BTCUSDT"\n')
    json.dump({"symbol": "BTCUSDT"}, open(os.path.join(d, "stats.json"), "w"))
json.dump({"amounts": {n: 1 for n in NAMES}}, open(os.path.join(WS, "manager", "portfolio_config.json"), "w"))
cl._split_by_type = lambda names: (set(names), set())
cl._push = lambda *a, **k: None
LIMIT = 3
calls = []
real_may = rc.may_start


def fake_may(next_mb, running, free_mb=None, slots=None):
    calls.append(len(running))
    return len(running) < LIMIT


rc.may_start = fake_may
lock = threading.Lock()
live, peak_live, ran, overlap = set(), [0], [], []


def fake_refresh(name, timeout, backtest_hash=None):
    with lock:
        if name in live:
            overlap.append(name)
        live.add(name)
        peak_live[0] = max(peak_live[0], len(live))
        ran.append(name)
    time.sleep(0.6)
    with lock:
        live.discard(name)
    return int(time.time())


cl._refresh_stats = fake_refresh
ack = cl._cmd_stats_refresh({"names": NAMES})
time.sleep(0.2)
again = cl._cmd_stats_refresh({"names": ["p0", "p6"]})
check(ack["started"] == NAMES and again == {"started": [], "skipped": {"p0": "BUSY", "p6": "BUSY"}},
      f"P second press while queued / running → BUSY ({again})")


def idle(timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        with cl._PERF_PENDING_LOCK:
            if not cl._PERF_PENDING:
                return True
        time.sleep(0.05)
    return False


check(idle(), "P all finished")
check(peak_live[0] == LIMIT, f"P never more at once than the capacity ({peak_live[0]} of {LIMIT})")
check(sorted(ran) == sorted(NAMES) and not overlap, f"P each ran exactly once, never twice at once ({ran})")
check(len(calls) >= len(NAMES) and max(calls) <= LIMIT, f"P capacity re-judged before every start ({calls})")

# the sweep (exclusive) and the queue (shared) wait for each other
calls.clear()
ran.clear()
assert cl._STATS_REFRESH_LOCK.acquire(timeout=1)
cl._cmd_stats_refresh({"names": ["p1"]})
time.sleep(1.0)
check(ran == [], "P a queued run waits while the sweep holds the machine")
cl._STATS_REFRESH_LOCK.release()
check(idle() and ran == ["p1"], "P …and runs once it is released")
cl._cmd_stats_refresh({"names": ["p2"]})
time.sleep(0.1)
check(not cl._STATS_REFRESH_LOCK.acquire(timeout=0.1), "P the sweep cannot take the machine while a shared run is on")
check(idle(), "P (shared run done)")
check(cl._STATS_REFRESH_LOCK.acquire(timeout=1), "P …and can once it is done")
cl._STATS_REFRESH_LOCK.release()

# a thread that cannot be started gives its slot and name back, the rest still run
real_start = threading.Thread.start


def flaky_start(self):
    if self.name == "stats-refresh-p3":
        raise RuntimeError("can't start new thread")
    return real_start(self)


threading.Thread.start = flaky_start
ran.clear()
cl._cmd_stats_refresh({"names": ["p3", "p4"]})
done = idle()
threading.Thread.start = real_start
check(done and ran == ["p4"], f"P a failed thread start: that one not run, the rest are ({ran})")
check("p3" not in cl._STATS_REFRESH_LOCK.active and cl._STATS_REFRESH_LOCK.acquire(timeout=1),
      "P …its slot is released (the sweep can take the machine)")
cl._STATS_REFRESH_LOCK.release()
d3 = json.load(open(os.path.join(WS, "strategies", "p3", "perf_refresh.json")))
check(d3.get("status") == "failed" and cl._cmd_stats_refresh({"names": ["p3"]})["started"] == ["p3"] and idle(),
      f"P …recorded failed and pressable again ({d3})")

# the sweep pauses new button starts for its whole run (no starving it to its deadline)
ran.clear()
cl._STATS_REFRESH_LOCK.pause_shared()
cl._cmd_stats_refresh({"names": ["p5"]})
time.sleep(1.0)
check(ran == [], "P while the sweep runs, a new button batch does not start")
cl._STATS_REFRESH_LOCK.resume_shared()
check(idle() and ran == ["p5"], "P …and starts when the sweep is done")
seen = []
real_members = cl._sweep_members
cl._sweep_members = lambda names, deadline, now, reason: seen.append(cl._STATS_REFRESH_LOCK._paused) or 0
cl._bound_venue = lambda: True
cl._refresh_live_stats("t")
cl._sweep_members = real_members
check(seen == [1] and cl._STATS_REFRESH_LOCK._paused == 0, f"P the sweep holds the pause for its run and lifts it after ({seen})")
rc.may_start = real_may

shutil.rmtree(BASE, ignore_errors=True)
print(f"\n{'ALL PASS' if not fails else f'{fails} FAIL'}")
sys.exit(1 if fails else 0)
