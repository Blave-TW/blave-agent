"""
Report helper — build a report and drop it in `workspace/reports/`.

A report is a JSON document the platform stores and the web workspace renders in
its Reports list (charts, KPI rows, tables, prose). The machine publishes one by
landing a file at `workspace/reports/<id>.json`. **The write is the finish line:**
the runtime's uploader (a 2-minute timer) ships it and moves the file to
`reports/sent/`, or to `reports/failed/` plus a line in
`reports/upload_errors.log`. Do not wait for the upload before saying the report
is produced.

This module is a convenience only — the drop directory is the contract, so a
report written with `json.dump` into that path works exactly the same. What it
saves you: the atomic write the contract requires, the envelope boilerplate, the
mandatory leading `meta` block, the image sidecar (written before the JSON, in
the order the contract requires), and the three-directory status check.

Block types and their fields: `references/reports.md`.

Usage:
    from lib.report import write_report

    path = write_report(
        "mcpt-2317-20260901",
        "2317 策略績效勝過 98.8% 的隨機排列",
        [
            {"type": "text", "variant": "lead", "markdown": "p = 0.012..."},
            {"type": "kpi_row", "items": [
                {"label": "p-value", "value": "0.012", "tone": "neutral"}]},
            {"type": "image", "file": "perm.png", "alt": "permutation histogram"},
        ],
        type="research",
        report_type="一次性",
        images={"perm.png": open("tmp/perm.png", "rb").read()},
    )

Diagnosis only — never the next step after `write_report`. Reach for it when a
report never appeared or you suspect it was refused:

    from lib.report import status
    status("mcpt-2317-20260901")   # 'pending' | 'sent' | 'failed: <reason>' | 'unknown'
"""

import json
import os
import re
import shutil
import time
import unicodedata
from zoneinfo import ZoneInfo

# The uploader scans $BLAVE_AGENT_WORKSPACE/reports, so that env var wins when it
# is set. It is often absent though: scheduled strategy subprocesses are started
# with a minimal env that strips every BLAVE_* variable, so fall back to the
# directory this file lives in (lib/ is always inside the workspace).
WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)
REPORTS_DIR = os.path.join(WORKSPACE, "reports")
SENT_DIR = os.path.join(REPORTS_DIR, "sent")
FAILED_DIR = os.path.join(REPORTS_DIR, "failed")
ERROR_LOG = os.path.join(REPORTS_DIR, "upload_errors.log")

_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
# An `image` block's `file`: a plain name inside the sidecar, never a path. This one
# IS checked here — the name is used to open a file for writing, so `../` would put
# bytes outside the drop dir. Everything else about the picture (extension, size) is
# the uploader's call, and it reports through reports/upload_errors.log.
_FILE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")
FILES_SUFFIX = ".files"
# ≈ 40 CJK / 80 Latin: the public share page cuts a title at ~50 CJK, so this leaves a margin.
RESEARCH_TITLE_WIDTH = 80


def _research_warnings(title, blocks):
    """Two points of the research skeleton (references/reports.md §7b) that decide how a
    report reads when only its head is seen.
    Advisory only: a refused report is lost, a weak one can be rewritten. `blocks[0]`
    is the meta block by the time this runs, and its `title` is the one the web renders —
    a caller-supplied meta may differ from the envelope title."""
    out = []
    shown = blocks[0].get("title", title) if blocks and isinstance(blocks[0], dict) else title
    width = sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in str(shown))
    if width > RESEARCH_TITLE_WIDTH:
        out.append(f"research title is {width} wide (CJK counts 2), over {RESEARCH_TITLE_WIDTH}; "
                   "the report list truncates it, state the claim shorter "
                   "(references/reports.md 7b)")
    i = 1
    if i < len(blocks) and isinstance(blocks[i], dict) and blocks[i].get("variant") == "lead":
        i += 1
    if not (i < len(blocks) and isinstance(blocks[i], dict) and blocks[i].get("type") == "kpi_row"):
        out.append("research report has no kpi_row right after the lead; its first item is the "
                   "key number readers see first (references/reports.md 7b)")
    return out


def _shareable_warnings(type, meta):
    """`meta.shareable` (references/reports.md 7b B7) is the research self-check record and no
    longer gates sharing, so a missing one only nags; a non-bool is refused by the api."""
    return _shareable_only(type, meta)


def _shareable_only(type, meta):
    if "shareable" not in meta:
        return ["research report has no meta.shareable; record it true or false on purpose "
                "(references/reports.md 7b B7)"] if type == "research" else []
    if not isinstance(meta["shareable"], bool):
        return [f"meta.shareable must be true or false, got {meta['shareable']!r}; the api "
                "refuses the report (references/reports.md 7b B7)"]
    if type != "research":
        return [f"meta.shareable has no meaning on a {type} report, only on research; "
                "leave it out (references/reports.md 7b B7)"]
    return []


def _write_bytes(path, data):
    """One sidecar picture, written the way the report itself is: into a `.tmp` the
    uploader's scan ignores, then `os.replace()` so it appears whole or not at all."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def write_report(report_id, title, blocks, type="research", report_type=None,
                 created_at=None, meta=None, images=None):
    """Write one report into the drop directory. Returns the file path.

    report_id   `[A-Za-z0-9_-]{1,64}`; it is the file name AND the report id, and
                re-using it overwrites that report on the platform — so a
                deterministic id makes a re-run idempotent, and a per-run id
                (a date, a timestamp) keeps every run. Do NOT use the runtime's
                own ids (`daily-YYYY-MM-DD`, `wk-YYYY-MM-DD`).
    title       1–200 chars; shown in the report list and the push notification.
    blocks      the block list (see `references/reports.md`). A `meta` block is
                prepended unless blocks[0] already is one.
    type        `performance` / `morning` / `research` — report list grouping.
    report_type display string for the report header ("績效週報", "一次性");
                defaults to `type`.
    created_at  unix seconds, int; defaults to now.
    meta        extra props for the generated meta block (`period`, `account`,
                `benchmark`, `origin`, `machine`, `extra`, and on research the
                `shareable` boolean of references/reports.md 7b B7, which makes the
                report schema 1.3).
    images      `{file name: bytes}` for the picture sidecar `<id>.files/`, named
                from an `image` block as `{"type": "image", "file": "perm.png",
                "alt": ...}`. The uploader carries the bytes and swaps `file` for
                the `sha256` the platform stores — which is the only way to get a
                figure out of a scheduled run, where the machine token is stripped
                from the environment. png / jpg / jpeg / webp / gif, ≤2MB each.

    Nothing here is validated beyond the report id and the image file names (a name
    becomes a path on this disk, so it may not be one): the api is the only validator,
    and a second copy of the rules on this side would drift and start refusing reports
    the platform accepts. A rejected report lands in `reports/failed/` with the
    api's message (it names the offending field path) in `upload_errors.log`.
    For `type="research"` two points of the §7b skeleton (title width, a `kpi_row`
    right after the lead) and a missing `meta.shareable` are printed as `WARNING:`
    lines, as is a `shareable` that is not a bool or sits on another type — advice,
    never a refusal.
    """
    if not isinstance(report_id, str) or not _ID_RE.fullmatch(report_id):
        raise ValueError(f"report id {report_id!r} must match [A-Za-z0-9_-]{{1,64}}")
    # Check every name before writing any of them: a bad one halfway through would
    # otherwise leave a sidecar holding some of the pictures and raise anyway.
    for name in images or {}:
        if not isinstance(name, str) or not _FILE_RE.fullmatch(name):
            raise ValueError(f"image name {name!r} must be a plain file name "
                             "matching [A-Za-z0-9][A-Za-z0-9._-]{0,79}, not a path")
    blocks = list(blocks)
    created_at = int(created_at if created_at is not None else time.time())
    if not blocks or not (isinstance(blocks[0], dict) and blocks[0].get("type") == "meta"):
        head = {"type": "meta", "title": title,
                "report_type": report_type or type, "generated_at": created_at}
        head.update(meta or {})
        blocks.insert(0, head)
    # Each bump only when its content is present, so a report without it is still accepted
    # by an api one version behind. 1.4 = a news block, a `private` block or a footnote link. The 1.3 meta flags count by presence: an explicit false
    # is still a prop a 1.1/1.2 validator refuses.
    if any(isinstance(b, dict) and (b.get("type") == "news" or "private" in b
                                    or (b.get("type") == "footnote"
                                        and any("url" in i for i in b.get("items") or [])))
           for b in blocks):
        version = "1.4"
    elif "shareable" in blocks[0] or "involves_futures" in blocks[0]:
        version = "1.3"
    elif any(isinstance(b, dict) and b.get("type") == "candlestick" for b in blocks):
        version = "1.2"
    else:
        version = "1.1"
    doc = {"schema_version": version, "id": report_id, "type": type,
           "title": title, "created_at": created_at, "blocks": blocks}

    os.makedirs(REPORTS_DIR, exist_ok=True)
    # Pictures first, JSON last — the report landing is what makes the set visible to
    # the uploader, so everything it references must already be on disk. Raising here
    # leaves a sidecar with no report, which the uploader sweeps after a day.
    for name, data in (images or {}).items():
        _write_bytes(os.path.join(REPORTS_DIR, report_id + FILES_SUFFIX, name), data)
    path = os.path.join(REPORTS_DIR, report_id + ".json")
    # Atomic: the uploader may scan mid-write. The temp name must not end in
    # `.json` or the scan would pick up the half-written file.
    tmp = path + ".tmp"
    # utf-8 explicitly — titles carry Chinese and a Windows machine's locale
    # default (cp950) raises on them. allow_nan=False so a NaN fails here, with
    # a stack trace, instead of being refused by the api hours later.
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, allow_nan=False)
        os.replace(tmp, path)
    except Exception:
        # A half-written .tmp is inert (the uploader only scans `.json`), but leaving
        # one behind after every rejected NaN just accumulates confusing litter.
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    # ASCII only: a report job's stdout goes to run.log in the Windows locale codec (cp950),
    # and an unencodable advisory line would fail a run whose report is already written.
    warnings = _research_warnings(title, blocks) if type == "research" else []
    warnings += _shareable_warnings(type, blocks[0])
    for w in warnings:
        print(f"WARNING: {w}")
    # Agents re-read reports/<id>.json to "verify" and hit FileNotFoundError once the uploader
    # has moved it (uid=1: five times in three turns) — say where the file goes before they try.
    print(f"[report] {report_id}.json written. The uploader moves it to reports/sent/, so do not "
          f"read reports/{report_id}.json back; if you need it again, open "
          f"reports/sent/{report_id}.json. It appears in the workspace Reports list (Reports in the sidebar) shortly. "
          "Nothing to check; reply now.")
    return path


JOBS_DIR = os.path.join(WORKSPACE, "report_jobs")
TIMEZONE_PATH = os.path.join(WORKSPACE, "state", "timezone")
_TZ_MAX = 64
_JOB_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
_CRON_FIELD_RE = re.compile(r"[0-9*,/-]+")
_CRON_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))


def _check_cron(cron):
    """The 5 normalised fields, or raise ValueError. Same grammar the runtime
    evaluates (numbers, `*`, ranges, lists, `/step`; minute 0–59, hour 0–23, day 1–31,
    month 1–12, weekday 0–7) — a registration that passes here shows up with a real
    next-run time instead of as a broken file the user can only delete."""
    fields = cron.split() if isinstance(cron, str) else []
    if len(fields) != 5 or not all(_CRON_FIELD_RE.fullmatch(f) for f in fields):
        raise ValueError(f"cron {cron!r} must be 5 fields of [0-9*,/-] (minute hour dom month dow)")
    for field, (lo, hi) in zip(fields, _CRON_RANGES):
        for part in field.split(","):
            step = 1
            if "/" in part:
                part, step_s = part.split("/", 1)
                if not step_s.isdigit() or int(step_s) < 1:
                    raise ValueError(f"cron {cron!r}: bad step in {field!r}")
                step = int(step_s)
            if part == "*":
                continue
            bounds = part.split("-", 1) if "-" in part else [part]
            if not all(b.isdigit() for b in bounds):
                raise ValueError(f"cron {cron!r}: bad value {part!r} in {field!r}")
            a, b = int(bounds[0]), int(bounds[-1])
            if a < lo or b > hi or a > b:
                raise ValueError(f"cron {cron!r}: {part!r} outside {lo}–{hi} in {field!r}")
    return fields


def _write_text_atomic(path, text):
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _machine_timezone():
    """The IANA zone the platform recorded for this machine's user, or "" (never set,
    unreadable, or a value that no longer resolves)."""
    try:
        with open(TIMEZONE_PATH, encoding="utf-8-sig") as f:
            tz = f.readline(_TZ_MAX + 1).strip()
    except FileNotFoundError:
        return ""  # never set — the caller's error message is the one that matters
    except (OSError, UnicodeDecodeError) as e:
        print(f"Error: {e}")
        return ""
    return tz if _tz_ok(tz) else ""


def set_timezone(tz):
    """Record which time zone the user is in (`state/timezone`, one IANA name). Returns it.

    The platform writes this from the user's browser when they open the workspace page, so
    you normally never call it. Call it when `register_schedule` tells you the machine has
    no time zone on record: ASK the user which zone they are in (「你在哪個時區?」), pass
    what they answer, then register. Never guess it from their language, their symbols or
    this machine's clock — every scheduled report they own is read in this zone.
    The platform's own write carries `if_unset`, so it will not overwrite what you set here.
    """
    if not _tz_ok(tz):
        raise ValueError(f"tz {tz!r} must be an IANA time zone name, e.g. 'Asia/Taipei' — "
                         "ask the user which time zone they are in")
    os.makedirs(os.path.dirname(TIMEZONE_PATH), exist_ok=True)
    _write_text_atomic(TIMEZONE_PATH, tz + "\n")
    return tz


def _tz_ok(tz):
    if not isinstance(tz, str) or not 1 <= len(tz) <= _TZ_MAX:
        return False
    try:
        ZoneInfo(tz)
    except (KeyError, ValueError):
        return False
    return True


def register_schedule(id, title, prompt, cron, human, script, enabled=True, tz=None):
    """Register (or update) a scheduled report: writes `report_jobs/<id>/run.py` and
    `job.json`. Returns the job directory. The runtime reads that file, fires the script
    when the cron comes due, records each run and reports the list to the web — never
    touch crontab / schtasks yourself.

    id      `[a-z0-9][a-z0-9-]{0,39}`, a slug (`perf-4h`, `tsmc-morning`); same id =
            update (keeps `created_at`, bumps `updated_at`, clears any pending edit).
    title   1–80 chars, the list row.
    prompt  1–2000 chars — the user's own words, verbatim, not your rewrite; the
            web shows it back to them as the report's description.
    cron    standard 5-field cron (no `@daily`, no seconds), **written in the user's own
            wall-clock time, exactly as they said it**: 台北 08:30 is `30 8 * * *`, full
            stop. Do NOT convert it to the machine's clock — the runtime evaluates the
            cron in `tz` (below), so a conversion would shift the report by that offset
            a second time. The same expression works on Linux and Windows.
    human   1–60 chars, the schedule in words (「每 4 小時」「每個交易日 08:30」);
            the only form the user ever sees, so make it match the cron exactly.
    script  the full text of run.py. It runs like a scheduled strategy: cwd is the
            workspace, every `BLAVE_*` variable stripped, no machine token; it
            publishes by writing into `reports/` (write_report / templates
            `publish(pack)`), and writes nothing when there is nothing to report.
    tz      IANA zone the cron is read in. Leave it out: it is taken from the machine's
            own setting (`state/timezone`, written by the platform from the user's
            browser). If that is missing this raises — ask the user which time zone they
            are in, record it with `set_timezone()`, then register; never guess one.
    """
    if not isinstance(id, str) or not _JOB_ID_RE.fullmatch(id):
        raise ValueError(f"job id {id!r} must match [a-z0-9][a-z0-9-]{{0,39}}")
    for name, value, cap in (("title", title, 80), ("prompt", prompt, 2000), ("human", human, 60)):
        if not isinstance(value, str) or not 1 <= len(value) <= cap:
            raise ValueError(f"{name} must be a string of 1–{cap} characters")
    fields = _check_cron(cron)
    if not isinstance(script, str) or not script.strip():
        raise ValueError("script must be the full text of run.py")
    if not isinstance(enabled, bool):
        raise ValueError("enabled must be True or False")
    if tz is None:
        tz = _machine_timezone()
    if not tz:
        raise ValueError(
            "this machine has no time zone on record (workspace/state/timezone), so the "
            "wall clock your cron would be read in is unknown. Ask the user which time "
            "zone they are in, record it with lib.report.set_timezone('Asia/Taipei'), then "
            "register again — do not guess it and do not convert the time yourself")
    if not _tz_ok(tz):
        raise ValueError(f"tz {tz!r} must be an IANA time zone name, e.g. 'Asia/Taipei'")

    job_dir = os.path.join(JOBS_DIR, id)
    os.makedirs(job_dir, exist_ok=True)
    now = int(time.time())
    created_at = now
    try:
        with open(os.path.join(job_dir, "job.json"), encoding="utf-8") as f:
            prev = json.load(f)
        if (isinstance(prev, dict) and isinstance(prev.get("created_at"), int)
                and not isinstance(prev["created_at"], bool)):
            created_at = prev["created_at"]
    except (OSError, ValueError):
        pass
    _write_text_atomic(os.path.join(job_dir, "run.py"), script)
    doc = {"id": id, "title": title, "prompt": prompt,
           "schedule": {"human": human, "cron": " ".join(fields), "tz": tz},
           "enabled": enabled, "created_at": created_at, "updated_at": now, "pending": None}
    _write_text_atomic(os.path.join(job_dir, "job.json"),
                       json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    return job_dir


def list_schedules():
    """Every registered job, for answering 「我有哪些定期報告」: the job.json fields
    plus `last_run` (the last line of the runtime's runs.jsonl, or None). A job whose
    job.json is unreadable comes back as `{"id", "error"}`."""
    try:
        names = sorted(os.listdir(JOBS_DIR))
    except OSError:
        return []
    out = []
    for name in names:
        d = os.path.join(JOBS_DIR, name)
        if not os.path.isdir(d):
            continue
        try:
            with open(os.path.join(d, "job.json"), encoding="utf-8") as f:
                doc = json.load(f)
            if not isinstance(doc, dict):
                raise ValueError("not an object")
        except (OSError, ValueError) as e:
            out.append({"id": name, "error": f"bad job.json: {e}"})
            continue
        doc["last_run"] = None
        try:
            with open(os.path.join(d, "runs.jsonl"), encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            if lines:
                doc["last_run"] = json.loads(lines[-1])
        except (OSError, ValueError):
            pass
        out.append(doc)
    return out


def remove_schedule(id):
    """Delete a job (registration, script and run history). True if it existed.
    Already-published reports are untouched. Use this when the user asks in chat;
    the web's own delete button does not come through here."""
    if not isinstance(id, str) or not _JOB_ID_RE.fullmatch(id):
        raise ValueError(f"job id {id!r} must match [a-z0-9][a-z0-9-]{{0,39}}")
    d = os.path.join(JOBS_DIR, id)
    if not os.path.isdir(d):
        return False
    shutil.rmtree(d)
    return True


def status(report_id):
    """Where a dropped report got to: 'pending' (still queued), 'sent',
    'failed' (with the reason), or 'unknown'.

    A diagnostic for after the fact, not a step after `write_report` — the
    uploader runs on a 2-minute timer, so never poll this waiting for 'sent'.

    'unknown' is not an error — `reports/sent/` keeps only the most recent ~20
    files, so a report that shipped a while ago reports 'unknown' too.
    """
    name = report_id + ".json"
    if os.path.exists(os.path.join(REPORTS_DIR, name)):
        return "pending"
    if os.path.exists(os.path.join(SENT_DIR, name)):
        return "sent"
    if os.path.exists(os.path.join(FAILED_DIR, name)):
        return f"failed: {_last_error(report_id) or 'see reports/upload_errors.log'}"
    return "unknown"


def _last_error(report_id):
    try:
        with open(ERROR_LOG, encoding="utf-8", errors="replace") as f:
            lines = [ln.strip() for ln in f if f" {report_id}: " in ln]
    except OSError:
        return None
    return lines[-1] if lines else None
