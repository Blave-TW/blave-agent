"""The watchboard is removed: on a machine that still carries its files (a `kind: "watch"`
job due every minute, pending ops / data under workspace/watch/), the runtime never runs the
job, never counts or lists it, and never sends anything to a watch endpoint — and leaves every
one of those files where it was. A report job and a report next to them still go out, so a
runtime that simply did nothing would fail here too.

No network (urlopen and Popen are replaced). Run: cd blave-agent && .venv/bin/python tests/check_watch_retired.py
"""
import glob
import json
import os
import re
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="watch-retired-")
WS = os.path.join(BASE, "workspace")
os.environ["BLAVE_AGENT_BASE"] = BASE
os.environ["BLAVE_AGENT_WORKSPACE"] = WS
os.environ["BLAVE_AGENT_STATE"] = os.path.join(BASE, "state")
os.environ["BLAVE_PROXY_TOKEN"] = "t"
os.environ.pop("BLAVE_AGENT_LOCAL", None)
os.makedirs(os.environ["BLAVE_AGENT_STATE"])
sys.path.insert(0, RUNTIME)

fails = 0


def check(cond, msg):
    global fails
    print(("PASS  " if cond else "FAIL  ") + msg)
    fails += 0 if cond else 1


def put(path, body, age=0):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body if isinstance(body, str) else json.dumps(body))
    if age:
        os.utime(path, (time.time() - age, time.time() - age))


NOW = int(time.time())
MARK = os.path.join(WS, "widget-script-ran")


def job(job_id, **extra):
    doc = {"id": job_id, "title": job_id, "schedule": {"human": "每分鐘", "cron": "* * * * *"},
           "enabled": True, "created_at": NOW - 86400, "updated_at": NOW - 86400, "pending": None}
    doc.update(extra)
    d = os.path.join(WS, "report_jobs", job_id)
    put(os.path.join(d, "job.json"), doc)
    put(os.path.join(d, "run.py"), f"open({MARK!r}, 'w').close()\n")


# what lib/watch.py left behind on a machine: a machine widget refreshed on a schedule
job("crypto-recs", kind="watch", widget_id="crypto-recs", block_type="table")
job("half-widget", kind="watch", id="someone-else")   # otherwise invalid: still not an error row
for i in range(20):                                    # the machine's full allowance of reports
    job(f"daily-{i:02d}", prompt="晨報")
OPS = os.path.join(WS, "watch", "ops", "1757800000000-add.json")
DATA = os.path.join(WS, "watch", "data", "crypto-recs.json")
SIDECAR = os.path.join(WS, "watch", "data", "gone.files", "a.png")
put(OPS, {"schema_version": "1.0", "op": "remove", "id": "crypto-recs"}, age=3600)
put(DATA, {"schema_version": "1.0", "widget_id": "crypto-recs", "generated_at": NOW,
           "block": {"type": "text", "markdown": "x"}}, age=3600)
put(SIDECAR, "png", age=3 * 86400)
os.utime(os.path.dirname(SIDECAR), (time.time() - 3 * 86400,) * 2)
put(os.path.join(WS, "reports", "r1.json"),
    {"schema_version": "1.0", "id": "r1", "type": "research", "title": "t", "created_at": NOW,
     "blocks": [{"type": "meta"}]}, age=3600)
before = {p: open(p, encoding="utf-8").read() for p in (OPS, DATA, SIDECAR)}

import command_listener as cl  # noqa: E402
import report_runner as R  # noqa: E402
import report_uploader as U  # noqa: E402
import strategy_reporter as sr  # noqa: E402

# ── the job: not listed, not counted, not fired, not runnable ────────────────
listed = R.list_jobs()
check([i for i, _j, _e in listed] == [f"daily-{i:02d}" for i in range(20)],
      "list_jobs: the watch jobs are not there (valid or not)")
check(all(j is not None for _i, j, _e in listed),
      "list_jobs: 20 report jobs next to them are all valid — a watch job takes no slot of the 20")
sched = sr.report_schedules()
check(len(sched) == 20 and not any("error" in s or s["id"] in ("crypto-recs", "half-widget") for s in sched),
      "report_schedules: no row and no error row for a watch job")

started = []
real_popen, cl.subprocess.Popen = cl.subprocess.Popen, lambda cmd, **kw: started.append(cmd[-1])
try:
    cl._fire_due_reports()                               # arms
    check("crypto-recs" not in cl._report_next and "daily-00" in cl._report_next,
          "scheduler: the watch job is never armed (the report job is)")
    for k, (cron, tz, _nxt) in list(cl._report_next.items()):
        cl._report_next[k] = (cron, tz, 0)               # every armed slot is now overdue
    cl._fire_due_reports()
finally:
    cl.subprocess.Popen = real_popen
check("daily-00" in started and not {"crypto-recs", "half-widget"} & set(started),
      f"scheduler: due slots start the report jobs only ({len(started)} started)")

check(R.run_job("crypto-recs") == 2 and not os.path.exists(MARK)
      and not os.path.exists(os.path.join(WS, "report_jobs", "crypto-recs", "runs.jsonl")),
      "run_job (立即執行 / a stale trigger): rc 2, run.py not executed, nothing recorded")

# ── the uploader: the report goes out, watch/ is not read, sent or cleaned ───
urls = []


class _Resp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b"{}"


def _urlopen(req, timeout=None):
    urls.append(f"{req.get_method()} {req.full_url}")
    return _Resp()


U.urllib.request.urlopen = _urlopen
U.main()
check(urls == ["PUT https://api.blave.org/openclaw/agent/report/r1"],
      f"report_uploader.main: one request, the report — nothing to a watch endpoint ({urls})")
check({p: open(p, encoding="utf-8").read() for p in before} == before
      and sorted(os.listdir(os.path.dirname(OPS))) == [os.path.basename(OPS)]
      and sorted(os.listdir(os.path.dirname(DATA))) == ["crypto-recs.json", "gone.files"],
      "workspace/watch/: ops, data and the day-old orphan sidecar are all still in place, no sent/ or failed/")

# ── every runtime file: no watch endpoint, drop dir, capability flag or lib left ──
PAT = re.compile(r"agent/watch|watch[\"']?\s*[,/]\s*[\"']?(?:ops|data)|can_watch|lib[./]watch|viewing_widgets")
hits = [f"{os.path.basename(p)}:{n}" for p in sorted(glob.glob(os.path.join(RUNTIME, "*.py")))
        for n, line in enumerate(open(p, encoding="utf-8"), 1) if PAT.search(line)]
check(not hits, f"runtime/*.py: no watchboard endpoint / drop dir / can_watch / lib.watch / viewing_widgets ({hits})")

print("\nALL PASS" if not fails else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
