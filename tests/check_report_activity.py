"""The desktop daemon's report activity (command_listener.report_activity → local_status.json
daemon.reports): the app's 06:00 scheduled update restarts only when no report runner is alive
and none comes due within 10 minutes; a missing field means "assume one is" on the shell side.

  1. running: a runner started by _start_report_job or report_run_now is tracked until it exits;
     a start thread still in its performance sweep counts as running, and so does a due slot the
     scheduler fired whose thread has not started yet.
  2. next_due_at: earliest slot over enabled jobs as UTC ISO; a paused job, a never-matching cron
     and no jobs at all give None; an armed slot already past (tick not fired yet) still counts.
  3. local_daemon writes it as daemon.reports, and a failure only drops that key.
Run: cd blave-agent && .venv/bin/python tests/check_report_activity.py
"""
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

print("\nALL PASS" if not fails else f"\n{fails} FAIL")
sys.exit(1 if fails else 0)
