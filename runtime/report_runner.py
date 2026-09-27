"""Scheduled report jobs: the `workspace/report_jobs/<id>/` contract and its runner.

Contract: `.claude/docs/report-schedules.md`. The agent only writes files (`run.py` +
`job.json`); this runtime owns the schedule (command_listener._fire_due_reports starts
this file when a job's cron comes due — nothing is ever installed in crontab/schtasks),
runs the script, records the outcome and reports it (strategy_reporter.report_schedules).

A watchboard machine widget (`.claude/docs/watchboard.md` §4.2) is the same job
with `"kind": "watch"` and the widget id as the job id: same trigger, same
runner, but success is judged by `watch/data/<id>.json` having been rewritten,
not by a report landing — the script writes that file, report_uploader ships it.

Usage (from the scheduler thread, or `report_run_now`):
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
from zoneinfo import ZoneInfo

WORKSPACE = os.environ.get("BLAVE_AGENT_WORKSPACE", "/opt/blave-agent/workspace")
JOBS_DIR = os.path.join(WORKSPACE, "report_jobs")
REPORTS_DIR = os.path.join(WORKSPACE, "reports")
WATCH_DATA_DIR = os.path.join(WORKSPACE, "watch", "data")
KINDS = ("report", "watch")

ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
REPORT_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")  # report_uploader's id shape
MAX_JOBS = 20
TITLE_MAX = 80
PROMPT_MAX = 2000
HUMAN_MAX = 60
MAX_TS = 4102444800  # 2100-01-01, same bound as the api's _ts
RUN_TIMEOUT_S = 600
# 排程報告先跑一輪 agent(寫判讀、整理新聞),失敗才退回 run.py 的純資料版
# (.claude/output/backend/scheduled-reports-agent-2026-09-26.md)。
# 只在雲端:電腦版排程這版照舊只出純資料版(Wei 09-26,排到下一版)。
AGENT_TIMEOUT_S = 600
AGENT_STOP_GRACE_S = 20      # 逾時先建停止旗標讓 turn_stop 收掉整棵樹(動錢的行程放過),再硬殺
AGENT_PER_DAY = 1            # 同一個 job 同一天(job 的時區)最多「起」幾次 agent 回合,失敗的也算
SLOT_WAIT_S = 600            # 等機器的回合名額(對話優先),等不到就降級
DEGRADED_ALERT_AFTER = 3     # 連續幾次降級才通知(P2)
DEGRADED_ALERT_COOLDOWN_S = 86400
STATE_DIR = os.environ.get("BLAVE_AGENT_STATE") or os.path.join(os.path.dirname(WORKSPACE), "state")
# 回合名額與 bridge 共用 runtime/turn_slots(同一份檔、同一套規則;稽核 0.1.7 P2-10 前是抄一份在這裡)
import turn_slots  # noqa: E402
SLOTS_DIR = turn_slots.SLOTS_DIR
LIMITS_PATH = turn_slots.LIMITS_PATH
MODEL_PREFS_PATH = os.environ.get("BLAVE_AGENT_MODEL_PREFS") or os.path.join(STATE_DIR, "model_prefs.json")
STOP_DIR = os.path.join(STATE_DIR, "turn_stop")
TURN_STOP_ENV = "BLAVE_TURN_INTERRUPT_FILE"   # = turn_stop.ENV
# 試用轉付費:排程從「不能叫 agent」變成「可以」的那一刻,每個還沒同意的報告 job 記一筆 P3、下一份報告尾註一句;
# 不自動開、不扣費(用戶得在對話裡聽過估價、同意,重新登記才開)
AVAIL_STATE_PATH = os.path.join(STATE_DIR, "sched_agent_available")
UPGRADE_NOTE = ".agent_available_note"
RUNS_KEEP = 50
REPORT_IDS_KEEP = 50
ERROR_TAIL = 200
PENDING_STALE_S = 600
NEXT_RUN_HORIZON_DAYS = 366
TZ_MAX = 64

# ── cron (5 fields, evaluated on schedule.tz's wall clock) ───────────────────

_FIELD_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
# ASCII only: a full-width digit passes str.isdigit() and would be read as a number
# the user never wrote (contract §3) — refuse the field instead.
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


def cron_next(expr, now=None, tz=None):
    """Next fire time as unix seconds, or None when the expression is invalid, `tz` is
    not a known zone, or nothing matches within NEXT_RUN_HORIZON_DAYS.

    Evaluated on the WALL CLOCK of `tz` (contract §3): the user's zone, not the
    machine's (machines are UTC). `tz=None` = the machine's own clock, which is what a
    registration written before the field existed gets. DST is zoneinfo's to carry —
    the scan walks wall-clock candidates and `.timestamp()` turns the one it picks into
    the instant that wall-clock time actually happens, so an 08:30 job stays 08:30 on
    both sides of a transition. Standard vixie rule for day-of-month vs weekday: both
    restricted → either matches.
    """
    spec = parse_cron(expr)
    if spec is None:
        return None
    try:
        tzinfo = ZoneInfo(tz) if tz else None
    except (KeyError, ValueError):
        return None
    minute, hour, dom, month, dow, dom_any, dow_any = spec
    start = datetime.fromtimestamp(time.time() if now is None else now, tzinfo)
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
                cand = datetime(d.year, d.month, d.day, h, m, tzinfo=tzinfo)
                if cand >= start:
                    return int(cand.timestamp())
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
        if doc.get("kind", "report") not in KINDS:
            raise ValueError("kind must be report or watch")
        _str(doc, "title", TITLE_MAX)
        # a watch job's script is not prompted into being the way a report is —
        # the field is optional there, still bounded when present
        if doc.get("kind") != "watch" or "prompt" in doc:
            _str(doc, "prompt", PROMPT_MAX)
        sched = doc.get("schedule")
        if not isinstance(sched, dict):
            raise ValueError("schedule must be an object")
        _str(sched, "human", HUMAN_MAX)
        if parse_cron(sched.get("cron")) is None:
            raise ValueError("schedule.cron must be a 5-field cron expression")
        tz = sched.get("tz")
        # Absent is NOT a broken file (contract §2): a registration written before the
        # field existed keeps running on the machine's own clock rather than vanishing
        # from the user's list.
        if tz is not None:
            if not isinstance(tz, str) or not 1 <= len(tz) <= TZ_MAX:
                raise ValueError(f"schedule.tz must be a string of 1-{TZ_MAX} characters")
            try:
                ZoneInfo(tz)
            except (KeyError, ValueError):
                raise ValueError(f"schedule.tz {tz!r} is not a known time zone")
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
    outright — there is no id to report it under. So is one with no job.json at all:
    contract §1 "存在即登記", and AGENTS has the agent write run.py for a sample run
    before the user confirms the schedule — reporting that draft as `bad job.json`
    put an error row in 管理定期報告 (uid=1, 2026-09-11). A job.json that exists but
    cannot be read or parsed is still an error."""
    try:
        names = sorted(os.listdir(JOBS_DIR))
    except OSError:
        return []
    out, valid = [], 0
    for name in names:
        if not ID_RE.fullmatch(name) or not os.path.isdir(job_dir(name)):
            continue
        if not os.path.lexists(os.path.join(job_dir(name), "job.json")):
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


# Copy of command_listener._LOCAL_ENV_PASS (the desktop strategy allowlist) — kept inline for
# the same stdlib-only reason; tests/check_report_runner_env.py pins the two equal.
_LOCAL_ENV_PASS = ("PATH", "HOME", "LANG", "USER", "SHELL", "TMPDIR",
                   "BLAVE_AGENT_BASE", "BLAVE_AGENT_WORKSPACE", "BLAVE_AGENT_HOME",
                   "BLAVE_AGENT_STATE", "BLAVE_KLINE_SOURCE", "PYTHONPYCACHEPREFIX")


def _subprocess_env():
    """Same rule as command_listener._strategy_subprocess_env (Linux allowlist,
    Windows drops BLAVE_* and TZ), inlined so the runner stays stdlib-only and a broken
    listener module cannot take a run down with it. Change both together.

    On the desktop (the local daemon started us with BLAVE_AGENT_LOCAL=1) a job gets what
    a desktop strategy gets — the _LOCAL_ENV_PASS names, BLAVE_KLINE_SOURCE=binance among
    them, so crypto klines come from Binance as in a chat turn — plus BLAVE_AGENT_LOCAL=1
    and the BLAVE_SCHEDULED_RUN=1 mark, so a report job can fall back to the key-free
    TWSE / TAIFEX series when the account has no Blave data (lib.data reads that state
    from the key the shell keeps in `.env`, and only under that mark). Strategies get
    neither flag."""
    if platform.system() == "Windows":
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("BLAVE_") and k != "TZ"}
    else:
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "USER", "SHELL")}
    env["BLAVE_MODE"] = "live"
    # 雲端也標排程:lib 靠它分辨「排程」與「對話」——休市日對話會落到最近交易日,排程要照舊跳過
    # (稽核 0.1.7 P1-2)。lib.data 的免 key 分支另外要求 BLAVE_AGENT_LOCAL=1,雲端不會誤走。
    env["BLAVE_SCHEDULED_RUN"] = "1"
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        env.update({k: v for k, v in os.environ.items() if k in _LOCAL_ENV_PASS})
        env["BLAVE_AGENT_LOCAL"] = "1"
        env["BLAVE_SCHEDULED_RUN"] = "1"
    return env


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


def _data_updated(job_id, since):
    """Whether watch/data/<id>.json was (re)written at or after `since` — the only
    evidence a watch job produced anything (the uploader leaves that file in place)."""
    try:
        return os.path.getmtime(os.path.join(WATCH_DATA_DIR, job_id + ".json")) >= since
    except OSError:
        return False


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


# ── agent run (排程報告的第一條路,雲端) ──────────────────────────────────


def _day(ts, tz):
    try:
        return datetime.fromtimestamp(ts, ZoneInfo(tz) if tz else None).date()
    except (KeyError, ValueError):
        return datetime.fromtimestamp(ts).date()


def _runs(jd):
    try:
        with open(os.path.join(jd, "runs.jsonl"), encoding="utf-8") as f:
            out = []
            for ln in f.read().splitlines():
                try:
                    e = json.loads(ln)
                except ValueError:
                    continue
                if isinstance(e, dict):
                    out.append(e)
            return out
    except OSError:
        return []


def _agent_day_path(jd):
    return os.path.join(jd, ".agent_day")


def _agent_attempts_today(jd, now, tz):
    """Agent turns started today. Kept in report_jobs/<id>/.agent_day, not counted from
    runs.jsonl: that file keeps only the last RUNS_KEEP lines, so a busy cron would push the
    day's attempt out and wake the agent again."""
    try:
        with open(_agent_day_path(jd), encoding="utf-8") as f:
            d = json.load(f)
        return int(d["n"]) if d.get("date") == _day(now, tz).isoformat() else 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return 0


def _count_attempt(jd, now, tz):
    """Written under the job's flock BEFORE the turn starts: a runner killed mid-turn still
    counted it."""
    n = _agent_attempts_today(jd, now, tz) + 1
    tmp = _agent_day_path(jd) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"date": _day(now, tz).isoformat(), "n": n}, f)
    os.replace(tmp, _agent_day_path(jd))


# 不算進「連續降級」:不是 agent 壞了(已跑過、沒點數、沒同意、app 關著),通知只會吵
_STREAK_NEUTRAL = ("daily_cap", "balance")


def _consecutive_degraded(jd):
    n = 0
    for e in reversed(_runs(jd)):
        if e.get("reason") == "app_closed" or e.get("degraded") in _STREAK_NEUTRAL or e.get("agent_skipped"):
            continue
        if not e.get("degraded"):
            break
        n += 1
    return n


_SIMPLIFIED = re.compile("[们这报币价发时为么国对说]")


def job_lang(job):
    """The report's language for the unattended turn: the language the user asked in. The turn's
    message is the English wrapper below, so agent_turn's own guess reads it as English and the
    whole report came out in English (09-26 simulation). zh / cn / None (no Chinese: leave it)."""
    words = job.get("prompt") or job.get("title") or ""
    if not re.search("[一-鿿]", words):
        return None
    return "cn" if _SIMPLIFIED.search(words) else "zh"


def _pack_call(job):
    """The exact pack call for this job, so the turn does not read run.py or lib to find it."""
    jd = job_dir(job["id"])
    if os.path.isfile(os.path.join(jd, "recipe.json")):
        return (f"from lib.report_templates import build, load_recipe, publish; "
                f"pack = build(load_recipe(\"report_jobs/{job['id']}/run.py\"), extra=[...])")
    try:
        with open(os.path.join(jd, "run.py"), encoding="utf-8") as f:
            src = f.read()
    except OSError:
        src = ""
    m = _TEMPLATE_CALL.search(src)
    args, depth = None, 1
    if m:
        for i in range(m.end(), len(src)):
            depth += {"(": 1, ")": -1}.get(src[i], 0)
            if depth == 0:
                args = src[m.end():i].strip()
                break
    if args is None or "extra" in args or "\n" in args:
        return None
    return (f"from lib.report_templates import {m.group(1)}, publish; "
            f"pack = {m.group(1)}({args + ', ' if args else ''}extra=[...])")


_TEMPLATE_CALL = re.compile(r"\b(tw_market_brief|tw_close_brief|crypto_market_brief|symbol_brief|research_pack)\(")


def scheduled_prompt(job):
    """The one message a scheduled agent turn gets: the user's own request plus the rules of
    an unattended run. The agent-facing rules live in references/reports.md §8."""
    call = _pack_call(job)
    return (
        f"[Scheduled report run — nobody is watching] Job `{job['id']}` 「{job['title']}」 is due. "
        f"The user asked for it in these words: 「{job['prompt']}」.\n"
        f"Produce today's report exactly as you would in chat, in the user's language, in as few steps as "
        f"you can — every step re-reads the whole context and this run has a fixed budget. The working "
        f"directory is the workspace and python3 imports lib/ from it: do not look around. "
        f"1) News first — no built-in browser here: 2–3 WebSearch queries in one message, then WebFetch "
        f"the best 3 articles from 3 different sites in one message, each with a short prompt (headline, "
        f"time, one line); stop there. Pick 1–3 things special today. 2) Build once, after the search, "
        f"with extra bricks for those things (at most 3; a brick is [name, {{params}}], not a news item — "
        f"a coin: [\"coin_snapshot\", {{\"symbol\": \"XRP\"}}] or [\"relative_to\", {{\"symbol\": \"XRP\"}}], an exchange: "
        f"[\"exchange_snapshot\", {{\"exchange\": \"okx\"}}], a Taiwan stock: [\"tw_institutional\", {{\"symbol\": \"2330\"}}] "
        f"or [\"price_chart\", {{\"symbol\": \"2330\"}}]; the news goes in the narrative) — one python3 call: "
        + (f"`{call}; print(pack.describe())`" if call else
           f"the pack report_jobs/{job['id']}/run.py builds, with extra=[...] added, then print(pack.describe())")
        + ". describe() prints every figure, rule and the narrative shape: do not read lib/ or references/. "
        "3) Write the narrative from it (summary is required) and call "
        "publish(pack, narrative, title=\"<today's conclusion>\") once; refused → fix every listed problem "
        "and publish(\"<report id>\", narrative, title=...) again. Do not ask anything — nobody will "
        "answer; a page or step that needs the user is skipped. Do not edit report_jobs/, strategies/, "
        "control/ or lib/, do not register or change schedules, never place or touch an order. "
        "If you cannot finish, stop: the plain data report is published for you."
    )


def current_model():
    """The user's model preference right now (runtime/model_prefs LAST_KEY) — a scheduled run
    follows it, it is not frozen at registration (Wei 09-26). None = the runtime's default."""
    try:
        with open(MODEL_PREFS_PATH, encoding="utf-8") as f:
            m = json.load(f).get("_last")
    except (OSError, ValueError, AttributeError):
        return None
    return m if isinstance(m, str) and re.fullmatch(r"[A-Za-z0-9._/:-]{1,80}", m) else None


def single_slot():
    """A trial machine or one with a single turn slot: its only slot stays the user's, so a
    scheduled report there is always data only (not a failure — no footnote, no notice). No
    turn_limits.json yet = unknown = treated as single (a trial box before the api's first answer)."""
    if not os.path.isfile(turn_slots.LIMITS_PATH):
        return True
    lim = turn_slots.read_limits()
    return lim["max_turns"] <= 1 or lim["trial"]


def _take_slot(deadline, job_id=""):
    """A machine-wide turn slot through turn_slots.acquire (chat keeps precedence: the same cap and
    memory gate the bridges use). Waits until `deadline`; None = busy."""
    while True:
        path = turn_slots.acquire(f"sched-{job_id}", "report")
        if path and path != "unslotted":
            return path
        if path == "unslotted":
            turn_slots.release(path)
        if time.time() >= deadline:
            return None
        time.sleep(5)


def _decode(v):
    """`TimeoutExpired.stdout` is bytes on POSIX even with text=True."""
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return v or ""


def sched_result_path(job_id):
    """Where agent_turn --scheduled writes its structured outcome (fault / subtype / api status /
    cost) — the runner reads only this, never the model's reply text."""
    return os.path.join(job_dir(job_id), ".sched_result.json")


def _agent_turn_cloud(job, model, on_start=lambda: None):
    """Run one unattended agent turn here. → (started, timed_out, output). `on_start` runs once
    the slot is held, right before the turn is spawned."""
    import threading
    slot = _take_slot(time.time() + SLOT_WAIT_S, job["id"])
    if slot is None:
        return False, False, "[report_runner] no free turn slot (chat first)"
    try:
        on_start()
    except Exception:
        # 寫不進 .agent_day 就不起回合:名額馬上還回去,例外讓 run_job 退回純資料版(failed)
        turn_slots.release(slot)
        raise
    stop = threading.Event()

    def keep():
        while not stop.wait(4):
            turn_slots.touch(slot)
    threading.Thread(target=keep, daemon=True).start()
    os.makedirs(STOP_DIR, exist_ok=True)
    stop_file = os.path.join(STOP_DIR, f"sched-{job['id']}-{os.getpid()}")
    here = os.path.dirname(os.path.abspath(__file__))
    cmd = [sys.executable, os.path.join(here, "agent_turn.py"), "--delivery=report", "--scheduled"]
    if model:
        cmd.append(f"--model={model}")
    lang = job_lang(job)
    if lang:
        cmd.append(f"--ui-lang={lang}")   # 機器上的回覆語言設定仍優先(agent_turn._resolve_reply_lang)
    cmd += ["--", f"sched-{job['id']}", scheduled_prompt(job)]
    # BLAVE_SCHEDULED_JOB: write_report 記 .published、agent_turn 寫 .sched_result.json;停止旗標走 turn_stop
    env = {**os.environ, "BLAVE_SCHEDULED_JOB": job["id"], TURN_STOP_ENV: stop_file}
    out, timed_out = "", False
    try:
        proc = subprocess.Popen(cmd, cwd=WORKSPACE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        try:
            out = _decode(proc.communicate(timeout=AGENT_TIMEOUT_S)[0])
        except subprocess.TimeoutExpired:
            timed_out = True
            try:   # 先請 turn_stop 收掉整棵樹(動錢的行程放過),寬限後才硬殺
                open(stop_file, "w").close()
            except OSError:
                pass
            try:
                out = _decode(proc.communicate(timeout=AGENT_STOP_GRACE_S)[0])
            except subprocess.TimeoutExpired as e:
                proc.kill()
                out = _decode(e.stdout)
                try:   # 被放過的動錢孫行程可能還握著 stdout:不無限等,讀不到就算了
                    out += _decode(proc.communicate(timeout=10)[0])
                except subprocess.TimeoutExpired:
                    pass
            out += f"\n[report_runner] agent turn timed out after {AGENT_TIMEOUT_S}s\n"
        return True, timed_out, out
    except OSError as e:
        return False, False, f"[report_runner] agent turn failed to start: {type(e).__name__}: {e}\n"
    finally:
        stop.set()
        for path in (slot, stop_file):
            try:
                os.remove(path)
            except OSError:
                pass


def _read_result(job_id):
    try:
        with open(sched_result_path(job_id), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _degrade_reason(started, timed_out, result):
    """From structured facts only (Q1): the runner's own timeout, and agent_turn's result file."""
    if not started:
        return "busy"
    if timed_out:
        return "timeout"
    if result.get("api_error_status") == 402:
        return "balance"
    if "budget" in str(result.get("subtype") or ""):
        return "budget"
    return "failed" if result.get("fault") else "no_report"


# 降級時純資料版尾註那一句(lib.report_templates.publish 讀 BLAVE_REPORT_DEGRADED)
DEGRADED_REASONS = ("timeout", "balance", "budget", "busy", "failed", "no_report", "daily_cap")


def agent_available():
    """This machine may run scheduled agent turns: a cloud machine with more than one turn slot and
    not on a trial (mirror of lib.report.scheduled_agent_available)."""
    return os.environ.get("BLAVE_AGENT_LOCAL") != "1" and not single_slot()


def _emit(interp, env, ev_type, **fields):
    """lib.events.emit in the workspace interpreter (this runner never imports workspace/lib).
    True only when the event was written."""
    code = ("import json, sys\nfrom lib.events import emit\n"
            "sys.exit(0 if emit(sys.argv[1], **json.loads(sys.argv[2])) is not None else 1)\n")
    try:
        r = subprocess.run([interp, "-c", code, ev_type, json.dumps(fields, ensure_ascii=False)], cwd=WORKSPACE,
                           env=env, capture_output=True, timeout=60)
        return r.returncode == 0
    except Exception as e:
        print(f"[report_runner] {ev_type} not written: {type(e).__name__}: {e}", file=sys.stderr)
        return False


def check_upgrade(interp, env):
    """False → True of agent_available() since the last run (a trial became paid): mark every
    report job without consent for one footnote line and record a P3 per job. First run on a
    machine only records the state."""
    if not os.path.isfile(LIMITS_PATH):
        return   # 讀不到機器的名額設定:不知道能不能叫 agent,不當成「可用」(也不記狀態)
    now_ok = agent_available()
    try:
        with open(AVAIL_STATE_PATH, encoding="utf-8") as f:
            prev = f.read().strip()
    except OSError:
        prev = None
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(AVAIL_STATE_PATH, "w", encoding="utf-8") as f:
            f.write("1" if now_ok else "0")
    except OSError:
        return
    if prev != "0" or not now_ok:
        return
    for job_id, job, _err in list_jobs():
        if job is None or job.get("kind") == "watch" or job.get("agent_consent") is True:
            continue
        try:
            open(os.path.join(job_dir(job_id), UPGRADE_NOTE), "w").close()
        except OSError:
            continue
        _emit(interp, env, "report_agent_available", job=job_id)


def _notify_degraded(job, reason, count, interp, env):
    """P2 `report_degraded` (notifications.md 草稿): its own event type and its own cooldown
    file — never shares alert_failure's, which must stay free for a run that produced nothing."""
    stamp = os.path.join(job_dir(job["id"]), ".degraded_alert")
    try:
        if time.time() - os.path.getmtime(stamp) < DEGRADED_ALERT_COOLDOWN_S:
            return
    except OSError:
        pass
    if _emit(interp, env, "report_degraded", job=job["id"], title=job["title"], reason=reason, count=count):
        try:   # 送成功才進冷卻,送不出去下一次降級還會再試
            open(stamp, "w").close()
        except OSError:
            pass


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
    # `python3 report_jobs/<id>/run.py` puts report_jobs/<id>/ on sys.path, not the cwd,
    # so a run.py that does `from lib…` without its own sys.path.insert dies on import.
    # Added here, on top of the strategy env, so _subprocess_env stays the twin of
    # command_listener._strategy_subprocess_env (strategies pin the path in
    # manager/wait_for_bar.py themselves).
    env["PYTHONPATH"] = os.pathsep.join(p for p in (WORKSPACE, env.get("PYTHONPATH")) if p)
    started = int(time.time())
    agent = None
    if job.get("kind") != "watch":
        check_upgrade(interp, env)
        try:
            agent = _try_agent(job, jd, started, interp, env)
        except Exception as e:   # 不管 agent 那段怎麼壞,都要走到下面的純資料版
            agent = {"mode": "data", "degraded": "failed", "attempted": False,
                     "out": f"[report_runner] agent path crashed: {type(e).__name__}: {e}\n"}
        if agent["mode"] == "agent":
            entry = {"started_at": started, "finished_at": int(time.time()), "status": "ok", "rc": 0,
                     "report_ids": agent["report_ids"][:REPORT_IDS_KEEP], "mode": "agent", "agent_attempted": True}
            _write_log(jd, agent["out"])
            _append_run(jd, entry)
            lock.close()
            return 0
        if agent.get("degraded"):
            env["BLAVE_REPORT_DEGRADED"] = agent["degraded"]
        elif agent.get("agent_skipped") == "no_consent" and os.path.exists(os.path.join(jd, UPGRADE_NOTE)):
            env["BLAVE_REPORT_NOTE"] = "agent_available"
    agent_out = (agent or {}).get("out", "")
    since = int(time.time())   # 只認 run.py 這一段寫出的報告(agent 那段最長 20 分鐘,Q2)
    rc = None
    try:
        r = subprocess.run([interp, os.path.join("report_jobs", job_id, "run.py")],
                           cwd=WORKSPACE, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, errors="replace",
                           timeout=RUN_TIMEOUT_S)
        output, rc = r.stdout or "", r.returncode
    except subprocess.TimeoutExpired as e:
        output = _decode(e.stdout) + f"\n[report_runner] timed out after {RUN_TIMEOUT_S}s\n"
    except OSError as e:
        output = f"[report_runner] failed to start: {type(e).__name__}: {e}\n"
    _write_log(jd, (agent_out + "\n--- data-only fallback ---\n" if agent_out else "") + output)
    if job.get("kind") == "watch":
        report_ids = []
        produced = _data_updated(job_id, started)
        if rc == 0 and not produced:
            print(f"[report_runner] {job_id}: exit 0 but watch/data/{job_id}.json was not "
                  "updated", file=sys.stderr)
    else:
        report_ids = _new_reports(since)
        produced = bool(report_ids)
    if rc != 0:
        status = "failed"
    else:
        status = "ok" if produced else "skipped"
    entry = {"started_at": started, "finished_at": int(time.time()), "status": status,
             "rc": rc, "report_ids": report_ids}
    if agent is not None:
        entry["mode"] = "data"
        for k in ("degraded", "agent_skipped"):
            if agent.get(k):
                entry[k] = agent[k]
        if agent.get("attempted"):
            entry["agent_attempted"] = True
    if status == "failed":
        entry["error"] = output.strip()[-ERROR_TAIL:]
    _append_run(jd, entry)
    if env.get("BLAVE_REPORT_NOTE") and status == "ok":
        try:   # 那一句只講一次
            os.remove(os.path.join(jd, UPGRADE_NOTE))
        except OSError:
            pass
    if status == "failed":
        _alert(job_id, rc, entry["error"], interp, env)
    elif entry.get("degraded") and entry["degraded"] not in _STREAK_NEUTRAL:
        n = _consecutive_degraded(jd)
        if n >= DEGRADED_ALERT_AFTER:
            _notify_degraded(job, entry["degraded"], n, interp, env)
    lock.close()
    return 1 if status == "failed" else 0


def _write_log(jd, text):
    try:
        with open(os.path.join(jd, "run.log"), "w", encoding="utf-8") as f:
            f.write(text)
    except OSError as e:
        print(f"[report_runner] run.log write failed: {e}", file=sys.stderr)


_CLOSE_CHECK = (
    "import json, sys\n"
    "from lib.data import is_tw_trading_day\n"
    "from lib.report_templates import headers_from_env\n"
    "print(json.dumps(is_tw_trading_day(sys.argv[1], headers_from_env())))\n")


def _is_close_job(jd):
    """A 台股收盤報告 job (the template, or a custom recipe in close mode): it has nothing to say on
    a day the market is shut."""
    try:
        with open(os.path.join(jd, "recipe.json"), encoding="utf-8") as f:
            if json.load(f).get("mode") == "close":
                return True
    except (OSError, ValueError, AttributeError):
        pass
    try:
        with open(os.path.join(jd, "run.py"), encoding="utf-8") as f:
            return "tw_close_brief" in f.read()
    except OSError:
        return False


def _market_closed(job, jd, started, interp, env):
    """True when a close-report job fires on a TWSE non-trading day (job's tz date): the agent turn
    would search the news, then find out at build time — budget spent for nothing. Weekend without
    a fetch; a holiday via lib.data.is_tw_trading_day in the workspace interpreter. Unknown → False."""
    if not _is_close_job(jd):
        return False
    day = _day(started, "Asia/Taipei")
    if day.weekday() >= 5:
        return True
    try:
        r = subprocess.run([interp, "-c", _CLOSE_CHECK, day.isoformat()], cwd=WORKSPACE, env=env, capture_output=True,
                           text=True, timeout=60)
        return r.returncode == 0 and r.stdout.strip().splitlines()[-1:] == ["false"]
    except Exception:
        return False


def _try_agent(job, jd, started, interp=None, env=None):
    """{"mode": "agent", "report_ids", "out"} when the agent published the report; else
    {"mode": "data", "degraded"?: reason (footnote), "agent_skipped"?: why no agent at all,
    "attempted": a turn was started (counts towards the daily cap), "out"}."""
    if os.environ.get("BLAVE_AGENT_LOCAL") == "1":
        return {"mode": "data", "agent_skipped": "desktop", "out": ""}   # 電腦版排程這版照舊(下一版)
    if job.get("agent_consent") is not True:
        # 登記時沒聽過「每份會扣點」的估價、沒同意的 job(含這版之前登記的全部):照舊出資料版、
        # 不加尾註;重新登記並同意後才叫 agent
        return {"mode": "data", "agent_skipped": "no_consent", "out": ""}
    if single_slot():
        return {"mode": "data", "agent_skipped": "single_slot", "out": ""}
    if interp and _market_closed(job, jd, started, interp, env):
        # 休市:不起回合、不花預算、不算次數;run.py 那段照舊跳過(BLAVE_SCHEDULED_RUN)
        return {"mode": "data", "agent_skipped": "market_closed", "out": ""}
    tz = job["schedule"].get("tz")
    if _agent_attempts_today(jd, started, tz) >= AGENT_PER_DAY:
        return {"mode": "data", "degraded": "daily_cap", "out": ""}
    for name in (".published", os.path.basename(sched_result_path(job["id"]))):
        try:
            os.remove(os.path.join(jd, name))
        except OSError:
            pass
    ran, timed_out, out = _agent_turn_cloud(job, current_model(), lambda: _count_attempt(jd, started, tz))
    ids = _published(os.path.join(jd, ".published"))
    if ids:
        return {"mode": "agent", "report_ids": ids, "out": out}
    return {"mode": "data", "degraded": _degrade_reason(ran, timed_out, _read_result(job["id"])),
            "attempted": ran, "out": out}


def _published(marker):
    """Report ids the scheduled turn wrote (lib.report.write_report under BLAVE_SCHEDULED_JOB);
    only a narrated one counts — a data-only `-auto` is what the fallback is for."""
    try:
        with open(marker, encoding="utf-8") as f:
            ids = [ln.strip() for ln in f if REPORT_ID_RE.fullmatch(ln.strip())]
    except OSError:
        return []
    return [i for i in ids if not i.endswith("-auto")]


def record_missed(job_id, since, now):
    """Desktop: a slot that came due while the app (and so this scheduler) was closed is not
    made up — it is recorded once as skipped / app_closed, so 管理定期報告 shows it."""
    job, _err = load_job(job_id)
    if job is None or not job.get("enabled") or job.get("kind") == "watch":
        return False
    last = last_run(job_id) or {}
    ref = max(since, int(last.get("started_at") or 0), int(job.get("updated_at") or 0))
    if ref <= 0:
        return False   # 手寫、沒有 updated_at 也沒跑過的 job:沒有起點可算,不從 1970 年迭代
    cron, tz = job["schedule"]["cron"], job["schedule"].get("tz")
    missed, nxt = None, cron_next(cron, ref, tz)
    for _ in range(400):   # the latest slot that came due, however many were missed: one entry
        if nxt is None or nxt > now:
            break
        missed, nxt = nxt, cron_next(cron, nxt, tz)
    if missed is None:
        return False
    _append_run(job_dir(job_id), {"started_at": missed, "finished_at": now, "status": "skipped",
                                  "rc": None, "report_ids": [], "reason": "app_closed"})
    return True


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
