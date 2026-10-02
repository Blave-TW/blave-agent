"""One-shot heal of the workspace's kline2 cache, run by portfolio_reporter after a report.

Until 2026-10-01 api /kline returned a partial bar one day past end_date (5m/1m base
resampled up to the next day's 00:00). lib/data.py before VERSION 2026-10-01 merged it
into past-month parquets under cache/kline2_*, which that lib never re-fetches. The lib
fix renamed the namespace to kline3, but lib only reaches machines whose workspace was
updated; this reaches every machine through the runtime channel.

Nothing is deleted or rewritten: each affected past-month file gets its mtime set back
to the first instant of its month. lib's _written_before_month_end (VERSION 2026-08-11
and later) reads that as "cached mid-month" and answers with one completing re-fetch,
merged keep='last', so the fixed api's bars replace the stray ones. A reader mid-call
sees the file either way; nothing disappears under a live round. The cost lands on the
next read of a flagged dir: every flagged past month in the requested range is
fetched again (in practice START to last month), once.

Which files: past months only (the current month is delta-updated by lib anyway), last
written before the cutoff and not an empty-month marker (no rows, cannot hold a stray
bar). In 1-minute / 5-minute dirs (any spelling: 1m, 1min, 5T…) the stray bar was a
complete base bar, harmless inside a month; there only a near-empty file is flagged — a
batch cold fetch ending on a month's last day wrote the stray bar alone into the next
month's file, which then passes as complete.

Pacing, so the re-fetch never lands fleet-wide or dir-wide on one bar close: each machine
waits a random 0-STAGGER_MAX_S before its first step, then flags at most DIRS_PER_STEP
dirs per STEP_S. A lib that cannot re-fetch (pre 2026-08-11) or no longer reads kline2
(kline3) is recorded and left alone.

State in state/kline2_heal.json, forwarded in the portfolio report as `kline2_heal`. A
step is claimed in that file before any file is touched, so a state dir that cannot be
written means no heal at all, never an unbounded rescan.
"""
import calendar
import json
import os
import random
import re
import sys
import time

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
STATE_DIR = os.environ.get("BLAVE_AGENT_STATE") or os.path.join(os.path.dirname(WORKSPACE), "state")
RECORD_PATH = os.path.join(STATE_DIR, "kline2_heal.json")

# A day after the api fix went live: a file written later came from the fixed api. Erring
# late only costs a re-fetch of files written on the fix day.
FIX_TS = calendar.timegm((2026, 10, 3, 8, 0, 0))
STAGGER_MAX_S = 6 * 3600
STEP_S = 3600
DIRS_PER_STEP = 20
MAX_PASSES = 3
_MONTH_FILE = re.compile(r"^(\d{4})-(\d{2})\.parquet$")
# Lowercase m only: 1M is a month.
_MINUTES = re.compile(r"^(\d+)(?:m|[Mm][Ii][Nn]|T)$")
BASE_MINUTES = (1, 5)
# Measured with the lib's own writer: empty-month marker ~1.0 KB, a 1-row month ~4.3 KB,
# one day of 5m bars ~19.5 KB.
MARKER_MAX_BYTES = 2048
BASE_STRAY_MAX_BYTES = 8192
_UTIME_NOFOLLOW = os.utime in os.supports_follow_symlinks


def is_base_period(period):
    m = _MINUTES.match(period)
    return bool(m) and int(m.group(1)) in BASE_MINUTES


def lib_generation(workspace=WORKSPACE):
    """kline3 = reads the new namespace; kline2 = reads kline2 and re-fetches a past month
    whose mtime predates its end; pre_refetch = kline2 without that re-fetch."""
    try:
        with open(os.path.join(workspace, "lib", "data.py"), encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return "missing"
    if "'kline3'" in src:
        return "kline3"
    if "_written_before_month_end" in src:
        return "kline2"
    return "pre_refetch"


def heal(cutoff, after="", limit=None, workspace=WORKSPACE, now=None):
    """Flag the affected month files of up to `limit` kline2 dirs named after `after`.
    Returns (dirs_touched, files, errors, cursor); cursor None = no dirs left."""
    now = time.time() if now is None else now
    limit = DIRS_PER_STEP if limit is None else limit
    current_ym = time.strftime("%Y-%m", time.gmtime(now))
    try:
        entries = sorted((e for e in os.scandir(os.path.join(workspace, "cache"))
                          if e.name > after), key=lambda e: e.name)
    except OSError:
        return 0, 0, 0, None
    dirs = files = errors = seen = 0
    for d in entries:
        parts = d.name.split("_")
        if parts[0] != "kline2" or len(parts) < 3 or not d.is_dir(follow_symlinks=False):
            continue
        if seen == limit:
            return dirs, files, errors, last
        seen += 1
        last = d.name
        base = is_base_period(parts[1])
        touched = False
        try:
            month_files = list(os.scandir(d.path))
        except OSError:
            errors += 1
            continue
        for f in month_files:
            m = _MONTH_FILE.match(f.name)
            if not m or f.name[:7] >= current_ym or f.is_symlink():
                continue
            try:
                st = f.stat(follow_symlinks=False)
                if st.st_mtime >= cutoff or st.st_size <= MARKER_MAX_BYTES:
                    continue
                if base and st.st_size >= BASE_STRAY_MAX_BYTES:
                    continue
                times = (st.st_atime, calendar.timegm((int(m.group(1)), int(m.group(2)), 1, 0, 0, 0)))
                if _UTIME_NOFOLLOW:
                    os.utime(f.path, times, follow_symlinks=False)
                else:
                    os.utime(f.path, times)
            except OSError:
                errors += 1
                continue
            files += 1
            touched = True
        dirs += touched
    return dirs, files, errors, None


def read_record():
    try:
        with open(RECORD_PATH, encoding="utf-8") as f:
            rec = json.load(f)
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) else None


def _write_record(rec):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = RECORD_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f)
    os.replace(tmp, RECORD_PATH)


def run(now=None):
    """One tick: wait out the stagger, then one step of at most DIRS_PER_STEP dirs per
    STEP_S. A pass that hit errors is repeated, at most MAX_PASSES in all."""
    now = int(time.time() if now is None else now)
    rec = read_record()
    if rec and rec.get("outcome") in ("done", "partial", "skipped"):
        return rec
    if not rec:
        lib = lib_generation()
        if lib != "kline2":
            rec = {"at": now, "lib": lib, "outcome": "skipped"}
        else:
            rec = {"at": now, "lib": lib, "outcome": "waiting",
                   "next_step_at": now + int(random.uniform(0, STAGGER_MAX_S)),
                   "started_at": None, "pass": 1, "cursor": "",
                   "dirs": 0, "files": 0, "errors": 0, "pass_errors": 0}
        _write_record(rec)
        return rec
    if now < int(rec.get("next_step_at") or 0):
        return rec
    rec = dict(rec, outcome="healing", next_step_at=now + STEP_S, started_at=rec.get("started_at") or now)
    _write_record(rec)
    # A file rewritten after the heal started came from the fixed api — including one lib
    # completed after an earlier pass flagged it.
    dirs, files, errors, cursor = heal(min(FIX_TS, rec["started_at"]), rec.get("cursor") or "", now=now)
    rec.update(at=now, dirs=rec["dirs"] + dirs, files=rec["files"] + files,
               errors=rec["errors"] + errors, pass_errors=rec["pass_errors"] + errors, cursor=cursor or "")
    if cursor is None:
        if rec["pass_errors"] and rec["pass"] < MAX_PASSES:
            rec.update(outcome="waiting", **{"pass": rec["pass"] + 1, "pass_errors": 0})
        else:
            rec["outcome"] = "partial" if rec["pass_errors"] else "done"
    else:
        rec["outcome"] = "waiting"
    _write_record(rec)
    print(f"[kline_cache_heal] {rec}", file=sys.stderr)
    return rec
