"""Scheduled report jobs: the `workspace/report_jobs/<id>/` contract and its runner.

Contract: `.claude/docs/report-schedules.md`. The agent only writes files (`run.py` +
`job.json`); this runtime owns the schedule (command_listener._sync_report_crons
installs one crontab line / scheduled task per enabled job pointing at this file),
runs the script, records the outcome and reports it (strategy_reporter.report_schedules).

Usage (from the crontab line / schtasks, or `report_run_now`):
    report_runner.py <id>

Exit 2 = no such job / bad job.json, 3 = another run of the same job holds the lock
(both: nothing recorded); 1 = the run failed; 0 = ok or skipped. Stdlib-only, no
import of any other runtime module and never of workspace/lib/ — the workspace is
the agent's, and may be broken.
"""
import json
import os
import platform
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
JOBS_DIR = os.path.join(WORKSPACE, "report_jobs")
REPORTS_DIR = os.path.join(WORKSPACE, "reports")

ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
REPORT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")  # report_uploader's id shape
MAX_JOBS = 20
TITLE_MAX = 80
PROMPT_MAX = 2000
HUMAN_MAX = 60
MAX_TS = 4102444800  # 2100-01-01, same bound as the api's _ts
RUN_TIMEOUT_S = 600
RUNS_KEEP = 50
REPORT_IDS_KEEP = 50
ERROR_TAIL = 200
PENDING_STALE_S = 600
NEXT_RUN_HORIZON_DAYS = 366

# ── cron (5 fields, machine-local time) ──────────────────────────────────────

_FIELD_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
# ASCII only: a full-width digit or a stray tab passes str.isdigit()/split() but
# turns the crontab line into something `crontab -` refuses as a whole file.
_CRON_FIELD_RE = re.compile(r"[0-9*,/-]+")


def parse_cron(expr):
    """(minutes, hours, days, months, weekdays, dom_any, dow_any) as sets, or None.
    Numbers, `*`, ranges, lists and `/step` only — no `@daily`, no month/weekday
    names, no seconds field. Weekday 7 folds to 0 (Sunday)."""
    if not isinstance(expr, str):
        return None
    fields = expr.split()
    if len(fields) != 5 or not all(_CRON_FIELD_RE.fullmatch(f) for f in fields):
        return None
    sets = []
    for field, (lo, hi) in zip(fields, _FIELD_RANGES):
        vals = set()
        for part in field.split(","):
            step = 1
            if "/" in part:
                part, step_s = part.split("/", 1)
                if not step_s.isdigit() or int(step_s) < 1:
                    return None
                step = int(step_s)
            if part == "*":
                a, b = lo, hi
            elif "-" in part:
                a_s, b_s = part.split("-", 1)
                if not (a_s.isdigit() and b_s.isdigit()):
                    return None
                a, b = int(a_s), int(b_s)
            elif part.isdigit():
                a = int(part)
                b = hi if step > 1 else a  # vixie: "5/10" = 5,15,25,…
            else:
                return None
            if a < lo or b > hi or a > b:
                return None
            vals.update(range(a, b + 1, step))
        sets.append(vals)
    minute, hour, dom, month, dow = sets
    if 7 in dow:
        dow.discard(7)
        dow.add(0)
    return minute, hour, dom, month, dow, fields[2].startswith("*"), fields[4].startswith("*")


def cron_next(expr, now=None):
    """Next fire time as unix seconds (local clock), or None when the expression is
    invalid or nothing matches within NEXT_RUN_HORIZON_DAYS. Standard vixie rule for
    day-of-month vs weekday: both restricted → either matches."""
    spec = parse_cron(expr)
    if spec is None:
        return None
    minute, hour, dom, month, dow, dom_any, dow_any = spec
    start = datetime.fromtimestamp(time.time() if now is None else now)
    start = start.replace(second=0, microsecond=0) + timedelta(minutes=1)
    hours, minutes = sorted(hour), sorted(minute)
    first_day = start.date()
    for offset in range(NEXT_RUN_HORIZON_DAYS + 1):
        d = first_day + timedelta(days=offset)
        if d.month not in month:
            continue
        dom_ok, dow_ok = d.day in dom, d.isoweekday() % 7 in dow
        ok = (dom_ok or dow_ok) if not (dom_any or dow_any) else (dom_ok and dow_ok)
        if not ok:
            continue
        for h in hours:
            for m in minutes:
                cand = datetime(d.year, d.month, d.day, h, m)
                if cand >= start:
                    return int(time.mktime(cand.timetuple()))
    return None


_WIN_DAYS = ("SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT")
# Only steps that divide the hour / day: schtasks counts from the task's creation
# time, cron from :00 / 00:00 — for any other N the two disagree and next_run_at
# would lie about when the task fires.
_WIN_MINUTE_STEPS = (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)
_WIN_HOUR_STEPS = (1, 2, 3, 4, 6, 8, 12)


def cron_to_schtasks(expr):
    """schtasks schedule flags for the contract's Windows subset (§3), or None for
    anything schtasks cannot express one-to-one."""
    if parse_cron(expr) is None:
        return None
    mi, h, dom, mon, dow = expr.split()
    if mon != "*":
        return None
    if re.fullmatch(r"\*/[0-9]+", mi) and (h, dom, dow) == ("*", "*", "*"):
        n = int(mi[2:])
        return ["/sc", "minute", "/mo", str(n)] if n in _WIN_MINUTE_STEPS else None
    if not mi.isdigit():
        return None
    if re.fullmatch(r"\*/[0-9]+", h) and (dom, dow) == ("*", "*"):
        n = int(h[2:])
        if n not in _WIN_HOUR_STEPS:
            return None
        return ["/sc", "hourly", "/mo", str(n), "/st", f"00:{int(mi):02d}"]
    if not h.isdigit():
        return None
    st = f"{int(h):02d}:{int(mi):02d}"
    if (dom, dow) == ("*", "*"):
        return ["/sc", "daily", "/st", st]
    if dom == "*" and dow.isdigit():
        return ["/sc", "weekly", "/d", _WIN_DAYS[int(dow) % 7], "/st", st]
    if dow == "*" and dom.isdigit():
        return ["/sc", "monthly", "/d", dom, "/st", st]
    return None


# ── job.json ─────────────────────────────────────────────────────────────────


def job_dir(job_id):
    return os.path.join(JOBS_DIR, job_id)


def _str(doc, key, max_len):
    v = doc.get(key)
    if not isinstance(v, str) or not 1 <= len(v) <= max_len:
        raise ValueError(f"{key} must be a string of 1–{max_len} characters")
    return v


def _ts(v, key):
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= MAX_TS:
        raise ValueError(f"{key} must be a unix timestamp in seconds")
    return v


def load_job(job_id):
    """(job dict, None) or (None, "bad job.json: <reason>"). Validates the §2 shape;
    unknown fields are kept on the dict (handlers rewrite the file) but never reported."""
    path = os.path.join(job_dir(job_id), "job.json")
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except OSError as e:
        return None, f"bad job.json: {type(e).__name__}"
    except ValueError as e:
        return None, f"bad job.json: invalid JSON ({e})"
    try:
        if not isinstance(doc, dict):
            raise ValueError("not an object")
        if doc.get("id") != job_id:
            raise ValueError("id does not match the directory name")
        _str(doc, "title", TITLE_MAX)
        _str(doc, "prompt", PROMPT_MAX)
        sched = doc.get("schedule")
        if not isinstance(sched, dict):
            raise ValueError("schedule must be an object")
        _str(sched, "human", HUMAN_MAX)
        if parse_cron(sched.get("cron")) is None:
            raise ValueError("schedule.cron must be a 5-field cron expression")
        if not isinstance(doc.get("enabled"), bool):
            raise ValueError("enabled must be true or false")
        for key in ("created_at", "updated_at"):
            _ts(doc.get(key), key)
        pending = doc.get("pending")
        if pending is not None:
            if not isinstance(pending, dict):
                raise ValueError("pending must be null or an object")
            _ts(pending.get("since"), "pending.since")
    except ValueError as e:
        return None, f"bad job.json: {e}"
    return doc, None


def list_jobs():
    """[(id, job | None, error | None)] for every `report_jobs/<id>/`, sorted by id.
    Only valid registrations count towards MAX_JOBS; past it they are reported as
    errors and never installed. A directory whose name is not a valid id is skipped
    outright — there is no id to report it under."""
    try:
        names = sorted(os.listdir(JOBS_DIR))
    except OSError:
        return []
    out, valid = [], 0
    for name in names:
        if not ID_RE.fullmatch(name) or not os.path.isdir(job_dir(name)):
            continue
        job, err = load_job(name)
        if job is not None:
            valid += 1
            if valid > MAX_JOBS:
                job, err = None, f"too many jobs (max {MAX_JOBS})"
        out.append((name, job, err))
    return out


def _last_line(path):
    """The last non-empty line of a text file, or None (absent / unreadable / empty)."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = [ln for ln in f.read().splitlines() if ln.strip()]
    except OSError:
        return None
    return lines[-1] if lines else None


def last_run(job_id):
    """Last line of runs.jsonl as a dict, or None (never ran / unreadable)."""
    line = _last_line(os.path.join(job_dir(job_id), "runs.jsonl"))
    if line is None:
        return None
    try:
        entry = json.loads(line)
    except ValueError:
        return None
    return entry if isinstance(entry, dict) else None


# ── run ──────────────────────────────────────────────────────────────────────


def _subprocess_env():
    """Same rule as command_listener._strategy_subprocess_env (Linux allowlist,
    Windows drops BLAVE_*), inlined so the runner stays stdlib-only and a broken
    listener module cannot take a run down with it. Change both together."""
    if platform.system() == "Windows":
        env = {k: v for k, v in os.environ.items() if not k.startswith("BLAVE_")}
        env["BLAVE_MODE"] = "live"
        return env
    return {k: v for k, v in os.environ.items()
            if k in ("PATH", "HOME", "LANG", "USER", "SHELL")} | {"BLAVE_MODE": "live"}


def _acquire_lock(jd):
    """Non-blocking per-job lock (report_jobs/<id>/.lock); the open file is the
    lock, held until the process exits. None = another run of this job is live
    (立即執行 landing on the schedule's own fire), and this one must not write
    run.log / runs.jsonl over it."""
    fh = open(os.path.join(jd, ".lock"), "w")
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh


def _new_reports(since):
    """Stems of `*.json` written at or after `since` across reports/ and the two
    retire dirs — the uploader's path unit can pick a report up and move it to
    sent/ before run.py even exits, so a plain before/after diff of reports/ would
    call a successful run "skipped". Only stems the uploader would accept as ids,
    capped like the api caps the list."""
    out = set()
    for d in (REPORTS_DIR, os.path.join(REPORTS_DIR, "sent"), os.path.join(REPORTS_DIR, "failed")):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            if not name.endswith(".json") or not REPORT_ID_RE.fullmatch(name[:-5]):
                continue
            try:
                # `since` is floored to the second, so anything written after the run
                # began compares >= it — no tolerance needed (and one would re-count the
                # previous run's report on a back-to-back run)
                if os.path.getmtime(os.path.join(d, name)) >= since:
                    out.add(name[:-5])
            except OSError:
                continue
    return sorted(out)[:REPORT_IDS_KEEP]


def _append_run(jd, entry):
    """Append to runs.jsonl keeping the last RUNS_KEEP lines. Best-effort: a job
    deleted mid-run (report_delete) must not turn into a traceback."""
    path = os.path.join(jd, "runs.jsonl")
    try:
        try:
            with open(path, encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
        except OSError:
            lines = []
        lines.append(json.dumps(entry, ensure_ascii=False))
        lines = lines[-RUNS_KEEP:]
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, path)
    except OSError as e:
        print(f"[report_runner] runs.jsonl write failed: {type(e).__name__}: {e}", file=sys.stderr)


def _alert(job_id, rc, tail, interp, env):
    """Best-effort Telegram alert through the workspace's own manager/alert_failure.py,
    the way run_strategy.sh does it. That script keeps its 24h cooldown state under
    strategies/<name>/, so the job is named `report-<id>` there."""
    script = os.path.join(WORKSPACE, "manager", "alert_failure.py")
    if not os.path.isfile(script):
        return
    try:
        os.makedirs(os.path.join(WORKSPACE, "strategies", f"report-{job_id}"), exist_ok=True)
        subprocess.run([interp, script, f"report-{job_id}", str(rc), tail],
                       cwd=WORKSPACE, env=env, capture_output=True, timeout=60)
    except Exception as e:
        print(f"[report_runner] alert failed: {type(e).__name__}: {e}", file=sys.stderr)


def run_job(job_id):
    job, err = load_job(job_id)
    if job is None:
        print(f"[report_runner] {job_id}: {err}", file=sys.stderr)
        return 2
    jd = job_dir(job_id)
    lock = _acquire_lock(jd)
    if lock is None:
        print(f"[report_runner] {job_id}: another run is in progress", file=sys.stderr)
        return 3
    # PATH-resolved system python, not sys.executable: this runtime's venv carries
    # only the agent SDK, while run.py imports lib.data / pandas like a strategy does
    # (same reasoning as command_listener._tick_one).
    interp = "python" if platform.system() == "Windows" else "python3"
    env = _subprocess_env()
    started = int(time.time())
    rc = None
    try:
        r = subprocess.run([interp, os.path.join("report_jobs", job_id, "run.py")],
                           cwd=WORKSPACE, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, errors="replace",
                           timeout=RUN_TIMEOUT_S)
        output, rc = r.stdout or "", r.returncode
    except subprocess.TimeoutExpired as e:
        output = (e.stdout or "") + f"\n[report_runner] timed out after {RUN_TIMEOUT_S}s\n"
    except OSError as e:
        output = f"[report_runner] failed to start: {type(e).__name__}: {e}\n"
    try:
        with open(os.path.join(jd, "run.log"), "w", encoding="utf-8") as f:
            f.write(output)
    except OSError as e:
        print(f"[report_runner] run.log write failed: {e}", file=sys.stderr)
    report_ids = _new_reports(started)
    if rc != 0:
        status = "failed"
    else:
        status = "ok" if report_ids else "skipped"
    entry = {"started_at": started, "finished_at": int(time.time()), "status": status,
             "rc": rc, "report_ids": report_ids}
    if status == "failed":
        entry["error"] = output.strip()[-ERROR_TAIL:]
    _append_run(jd, entry)
    if status == "failed":
        _alert(job_id, rc, entry["error"], interp, env)
    lock.close()
    return 1 if status == "failed" else 0


def main():
    if len(sys.argv) != 2 or not ID_RE.fullmatch(sys.argv[1]):
        print("usage: report_runner.py <id>", file=sys.stderr)
        return 2
    if not os.path.isdir(job_dir(sys.argv[1])):
        print(f"[report_runner] no such job: {sys.argv[1]}", file=sys.stderr)
        return 2
    return run_job(sys.argv[1])


if __name__ == "__main__":
    sys.exit(main())
