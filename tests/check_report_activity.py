"""The desktop daemon's report activity (command_listener.report_activity → local_status.json
daemon.reports): the app's 06:00 scheduled update restarts only when no report runner is alive
and none comes due within 10 minutes; a missing field means "assume one is" on the shell side.

  1. running: a runner started by _start_report_job or report_run_now is tracked until it exits;
     a start thread still in its performance sweep counts as running, and so does a due slot the
     scheduler fired whose thread has not started yet.
  2. next_due_at: earliest slot over enabled jobs as UTC ISO; a paused job, a never-matching cron
     and no jobs at all give None; an armed slot already past (tick not fired yet) still counts.
  3. local_daemon writes it as daemon.reports, and a failure only drops that key.
  4. the other long jobs the 06:00 update waits out, each true only while it is really running:
     daemon.flattening (flatten_running: our Popens, else state/flatten_pids alive + command line;
     never reads or locks flatten.lock), daemon.optimizing (_OPT_LOCK), perf_refresh.json exec_test.
Run: cd blave-agent && .venv/bin/python tests/check_report_activity.py
"""
import json
import os
import sys
import tempfile
import threading
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="report-activity-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "state"))
os.environ.update({"BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE, "BLAVE_AGENT_BASE": BASE,
                   "BLAVE_AGENT_WORKSPACE": WS, "BLAVE_AGENT_STATE": os.path.join(BASE, "state"),
                   "BLAVE_AGENT_DB": os.path.join(BASE, "session.db"), "BLAVE_AGENT_LOCAL": "1"})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
sys.path.insert(0, RUNTIME)
sdk = types.ModuleType("claude_agent_sdk")
for _n in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock",
           "ResultMessage"):
    setattr(sdk, _n, type(_n, (), {}))
sdk.query = lambda **kw: None
sys.modules["claude_agent_sdk"] = sdk
import command_listener as cl  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


JOBS = {}
cl._report_jobs_wanted = lambda: dict(JOBS)
cl._refresh_live_stats = lambda why: None
STOP = os.path.join(BASE, "stop")
cl._report_runner_cmd = lambda job_id: [sys.executable, "-c",
                                        f"import os,time\nwhile not os.path.exists({STOP!r}): time.sleep(0.05)"]
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))

# ── 1. running ──
a = cl.report_activity()
check(a == {"running": False, "next_due_at": None}, f"nothing registered, nothing running ({a})")
cl._start_report_job("daily")
check(cl.report_activity()["running"] is True, "a runner started by the scheduler is running")
open(STOP, "w").close()
for _ in range(100):
    if not cl.report_activity()["running"]:
        break
    time.sleep(0.05)
check(cl.report_activity()["running"] is False, "it exits → running false (exited handles pruned)")
os.remove(STOP)
os.makedirs(os.path.join(WS, "report_jobs", "now1"))
cl._cmd_report_run_now({"id": "now1"})
check(cl.report_activity()["running"] is True, "report_run_now's runner is tracked too")
open(STOP, "w").close()
for _ in range(100):
    if not cl.report_activity()["running"]:
        break
    time.sleep(0.05)
check(cl.report_activity()["running"] is False, "…and released when it exits")
gate, entered = threading.Event(), threading.Event()
cl._refresh_live_stats = lambda why: (entered.set(), gate.wait(5))
th = threading.Thread(target=cl._start_report_job, args=("slow",))
th.start()
entered.wait(5)
check(cl.report_activity()["running"] is True, "start thread still in its performance sweep counts as running")
gate.set()
th.join(5)
for _ in range(100):
    if not cl.report_activity()["running"]:
        break
    time.sleep(0.05)
check(cl.report_activity()["running"] is False and cl._report_starting == 0, "sweep done, runner exited → running false")
cl._refresh_live_stats = lambda why: None
cl._report_runner_cmd = lambda job_id: ["/nonexistent/python-xyz"]
cl._start_report_job("broken")
check(cl.report_activity()["running"] is False and cl._report_starting == 0, "a runner that fails to start does not leave running stuck")

# a due slot fired by the scheduler counts as running from the moment _report_next moves on,
# before the start thread has run a single line (audit v036 P3-9)
held = []
real_thread = cl.threading.Thread


class _HeldThread:
    def __init__(self, target=None, args=(), **kw):
        self.target, self.args = target, args

    def start(self):
        held.append(self)


cl.threading.Thread = _HeldThread
JOBS["due"] = ("* * * * *", None)
cl._report_next["due"] = ("* * * * *", None, int(time.time()) - 1)
cl._fire_due_reports()
cl.threading.Thread = real_thread
a = cl.report_activity()
check(len(held) == 1 and a["running"] is True and cl._report_starting == 1,
      f"scheduler fired a due job: running before its start thread runs ({a}, {cl._report_starting})")
open(STOP, "w").close()
held[0].target(*held[0].args)
for _ in range(100):
    if not cl.report_activity()["running"]:
        break
    time.sleep(0.05)
check(cl._report_starting == 0 and cl.report_activity()["running"] is False,
      "…the thread does not count it twice; done → released")
os.remove(STOP)
JOBS.clear()
cl._report_next.clear()

# ── 2. next_due_at ──
now = int(time.time())
rr = cl._report_runner_mod()
JOBS.update({"a": ("30 6 * * *", "UTC"), "b": ("*/5 * * * *", "UTC")})
want = min(rr.cron_next("30 6 * * *", now, "UTC"), rr.cron_next("*/5 * * * *", now, "UTC"))
got = cl.report_activity()["next_due_at"]
check(got in (iso(want), iso(want + 300)), f"earliest coming slot across jobs, UTC ISO ({got} vs {iso(want)})")
JOBS.clear()
JOBS["c"] = ("0 0 31 2 *", "UTC")
check(cl.report_activity()["next_due_at"] is None, "a cron that never matches → None (not blocking forever)")
JOBS.clear()
JOBS["d"] = ("0 9 * * *", "Asia/Taipei")
cl._report_next["d"] = ("0 9 * * *", "Asia/Taipei", now - 20)
check(cl.report_activity()["next_due_at"] == iso(now - 20), "an armed slot already past still counts (about to fire)")
cl._report_next["gone"] = ("* * * * *", None, now - 5)
JOBS.clear()
check(cl.report_activity()["next_due_at"] is None, "paused/deleted jobs' leftover slots do not count")
cl._report_next.clear()

# ── 3. local_daemon wiring ──
src = open(os.path.join(RUNTIME, "local_daemon.py"), encoding="utf-8").read()
blk = src[src.index("def write_status(self):"):src.index("def _status_loop(self):")]
check('doc["daemon"]["reports"] = self.cl.report_activity()' in blk
      and blk.index('doc["daemon"] = {') < blk.index('doc["daemon"]["reports"]'),
      "write_status puts it in the daemon block, after that block is built")
sub = blk[blk.index('doc["daemon"]["reports"]') - 80:blk.index('doc["daemon"]["reports"]') + 200]
check("try:" in sub and "except Exception" in sub, "a failure only drops daemon.reports (status file still written)")
cl_src = open(os.path.join(RUNTIME, "command_listener.py"), encoding="utf-8").read()
spawns = [l for l in cl_src.splitlines() if "_report_runner_cmd(" in l and "def _report_runner_cmd" not in l]
check(len(spawns) == 1 and "subprocess.Popen(_report_runner_cmd(job_id)" in spawns[0],
      f"every runner Popen goes through _report_spawn (one call site, {len(spawns)})")

# ── 4. long jobs the scheduled update waits out ──
import platform as _platform  # noqa: E402
import subprocess as _sp  # noqa: E402
import fcntl as _fcntl  # noqa: E402
import atomic_file as _af  # noqa: E402
PIDS = os.path.join(WS, "state", "flatten_pids")
lock_reads, flocks = [], []
real_read, real_flock, real_cmd, real_sys = _af.read_bytes, _fcntl.flock, cl._pid_cmdline, _platform.system
_af.read_bytes = lambda p, *a, **k: (lock_reads.append(p) if os.path.basename(p) == "flatten.lock" else None, real_read(p, *a, **k))[1]
_fcntl.flock = lambda *a: (flocks.append(a), real_flock(*a))[1]
spawn = lambda: _sp.Popen([sys.executable, "-c", "import time; time.sleep(30)", "manager/flatten.py"])
pids_on_disk = lambda: open(PIDS, encoding="ascii").read().split() if os.path.exists(PIDS) else None
check(cl.flatten_running() is False, "no flatten launched, no pid list → not flattening")
a, b = spawn(), spawn()
cl._record_flatten(a)
cl._record_flatten(b)   # double press: both started before either took flatten.lock
check(pids_on_disk() == [str(a.pid), str(b.pid)], f"each launch appends its pid ({pids_on_disk()})")
cmd_calls = []
cl._pid_cmdline = lambda pid: (cmd_calls.append(pid), real_cmd(pid))[1]
check(cl.flatten_running() is True and not cmd_calls, f"our own flatten Popens alive → flattening, without a command-line lookup (a powershell each on Windows; {cmd_calls})")
cl._pid_cmdline = real_cmd
a.kill(); a.wait()
check(cl.flatten_running() is True, "double press: the loser exits, the winner still runs → still flattening")
cl._FLATTEN_PROCS.clear()   # a restarted daemon: no Popens, only the list on disk
check(cl.flatten_running() is True and pids_on_disk() == [str(b.pid)],
      f"daemon restarted under it: the listed pid alive with flatten.py on its command line → flattening, dead one pruned ({pids_on_disk()})")
_platform.system = lambda: "Windows"
cl._pid_cmdline = lambda pid: (r"C:\venv\Scripts\python.exe manager\flatten.py" if pid == b.pid else "")
check(cl.flatten_running() is True, "Windows, daemon restarted under it: seen through the pid list (no pid in flatten.lock there)")
_platform.system, cl._pid_cmdline = real_sys, real_cmd
b.kill(); b.wait()
check(cl.flatten_running() is False and pids_on_disk() is None, "every flatten gone → not flattening, the list file removed (no sticky flag)")
with open(PIDS, "w") as f:
    f.write(f"{os.getpid()}\ngarbage\n")
check(cl.flatten_running() is False and pids_on_disk() is None, "a live pid that is not flatten.py (pid reused), garbage → not flattening, pruned")
late = []
with open(PIDS, "w") as f:
    f.write("999999\n")
def _cmd_and_append(pid):
    if not late:
        late.append(1)
        _af.append_line(PIDS, "424242\n")   # a close_all landing while the check runs
    return ""
cl._pid_cmdline = _cmd_and_append
cl.flatten_running()
cl._pid_cmdline = real_cmd
check(pids_on_disk() == ["424242"], f"pruning keeps a pid appended while the check ran ({pids_on_disk()})")
os.remove(PIDS)
check(not lock_reads and not flocks, f"flatten_running never reads or locks state/flatten.lock ({lock_reads}, {len(flocks)} flock calls)")
_af.read_bytes, _fcntl.flock = real_read, real_flock
check(cl.optimize_running() is False, "no manage_optimize → not optimizing")
cl._OPT_LOCK.acquire()
check(cl.optimize_running() is True, "manage_optimize holding _OPT_LOCK → optimizing")
cl._OPT_LOCK.release()
check(cl.optimize_running() is False, "released by the Deferred cleanup → not optimizing")
os.makedirs(os.path.join(WS, "strategies", "xt"), exist_ok=True)
pf = lambda: json.load(open(os.path.join(WS, "strategies", "xt", "perf_refresh.json"), encoding="utf-8"))
cl._mark_perf("xt", "running", exec_test=True)
check(pf().get("exec_test") is True and pf().get("pid") == os.getpid(), f"a 成交測試 run's record carries exec_test ({pf()})")
cl._mark_perf("xt", "running")
check("exec_test" not in pf(), f"a plain 更新績效 record has no exec_test ({pf()})")
cl._mark_perf("xt", "failed", "EXIT", exec_test=True)
check("exec_test" not in pf(), "a failed record never says exec_test (only a running one is waited on)")
cl_src = open(os.path.join(RUNTIME, "command_listener.py"), encoding="utf-8").read()
marks = [l.strip() for l in cl_src.splitlines() if '_mark_perf(name, "running"' in l]
check(len(marks) == 2 and all("exec_test=exec_test" in l for l in marks),
      f"both running marks (the queue at ack time, the run itself) pass exec_test ({marks})")
check(cl_src.count("        _record_flatten(proc)\n") == 1, "the local-mode flatten launch records its Popen and pid")
for key in ('doc["daemon"]["flattening"] = self.cl.flatten_running()', 'doc["daemon"]["optimizing"] = self.cl.optimize_running()'):
    check(key in blk and blk.index('doc["daemon"] = {') < blk.index(key), f"write_status writes {key.split(' = ')[0]}")
sub = blk[blk.index('doc["daemon"]["flattening"]') - 120:blk.index('doc["daemon"]["optimizing"]') + 200]
check("try:" in sub and "except Exception" in sub, "a failure there only drops those keys (status file still written)")

print("\nALL PASS" if not fails else f"\n{fails} FAIL")
sys.exit(1 if fails else 0)
