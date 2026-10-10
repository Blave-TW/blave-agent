"""Minimal check for the `stats_refresh` command and the pre-report performance sweep — the
runtime half of 0.1.21 資源優化案 A (lib half: tests/check_live_tick_lean.py; spec
.claude/output/backend/live-tick-cpu-spec-2026-10-10.md §2–3). No network; real subprocesses in
a temp workspace carrying a copy of this repo's lib/.

  1. args: exactly {names: [1..50 names]}, each [A-Za-z0-9_-]{1,128}, no duplicates.
  2. per name: a Type B strategy → NOT_RUNNABLE; no stats.json → NO_STATS; queued twice → BUSY.
  3. the happy path: ack {started, skipped} at once, perf_refresh.json `running` + a push; the
     run is BLAVE_MODE=live + BLAVE_STATS_REFRESH=1; stats.json rewritten with Generated At and
     the version index untouched, no state.json, record gone, another push; the strategies
     report carries perf.at (= stats.json mtime) and perf.refresh only while running / failed.
  4. a failed run → perf.refresh {status: failed, err: DATA}; a listener restart settles a stale
     `running` record as failed EXIT.
  5. the pre-report sweep (_start_report_job): refreshes stale live Type A/C members in front of
     the report, skips Type B, skips a stats.json younger than an hour, does nothing unbound;
     _fire_due_reports goes through it.

Run: cd blave-agent && MPLBACKEND=Agg .venv/bin/python tests/check_stats_refresh_command.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="stats-refresh-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
shutil.copy(os.path.join(ROOT, "manager", "wait_for_bar.py"), os.path.join(WS, "manager"))
os.environ.update({"BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE, "BLAVE_AGENT_BASE": BASE,
                   "BLAVE_AGENT_WORKSPACE": WS, "BLAVE_AGENT_STATE": os.path.join(BASE, "state"),
                   "BLAVE_AGENT_DB": os.path.join(BASE, "session.db"),
                   "BLAVE_AGENT_LOCAL": "1",   # the child interpreter is this venv's (it has pandas)
                   "MPLBACKEND": "Agg", "PYTHONPYCACHEPREFIX": os.path.join(BASE, "pycache")})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
sys.path.insert(0, RUNTIME)
sdk = types.ModuleType("claude_agent_sdk")


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


for _n in ("ClaudeAgentOptions", "AssistantMessage", "TextBlock", "ToolUseBlock", "ThinkingBlock",
           "ResultMessage"):
    setattr(sdk, _n, type(_n, (_Obj,), {}))
sdk.query = lambda **kw: None
sys.modules["claude_agent_sdk"] = sdk
import command_listener as cl  # noqa: E402
import strategy_reporter as rep  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


PUSHES = []
cl._ON_APPLIED = lambda: PUSHES.append(time.time())
NAME = "momo"
SDIR = os.path.join(WS, "strategies", NAME)
os.makedirs(SDIR)
TEMPLATE = '''import json, os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import numpy as np
import pandas as pd
from lib.runner import run

STRATEGY_NAME = "{name}"
SYMBOL        = "BTCUSDT"
INTERVAL      = "1h"
START         = "2024-01-01"
FEE           = 0.0005
MCPT          = False


def fetch_data(hdrs):
    try:
        flags = json.loads(Path(__file__).with_name("flags.json").read_text())
    except (OSError, ValueError):
        flags = {{}}
    Path(__file__).with_name("env.json").write_text(
        json.dumps({{k: v for k, v in os.environ.items() if k.startswith("BLAVE_")}}))
    if flags.get("sleep"):
        time.sleep(float(flags["sleep"]))
    if flags.get("data"):
        from lib.data import DataAccessError
        raise DataAccessError("ERR007 test: no data access")
    n = int(flags.get("n", 300))
    idx = pd.date_range("2024-01-01", periods=n, freq="h")
    c = pd.Series(100 + np.cumsum(np.sin(np.arange(n) / 9.0)), index=idx)
    return pd.DataFrame({{"Open": c, "High": c, "Low": c, "Close": c, "Volume": 1.0}}, index=idx)


def compute(df):
    return pd.Series(np.where(np.arange(len(df)) % 30 < 15, 1.0, 0.0), index=df.index)


run(locals(), fetch_data, compute)
'''
with open(os.path.join(SDIR, "strategy.py"), "w", encoding="utf-8") as f:
    f.write(TEMPLATE.format(name=NAME))
# a Type B strategy: no INTERVAL / fetch_data contract, but it does have a stats.json
TB = os.path.join(WS, "strategies", "tb")
os.makedirs(TB)
with open(os.path.join(TB, "strategy.py"), "w") as f:
    f.write("import json, pathlib\npathlib.Path(__file__).with_name('ran').write_text('x')\n")
with open(os.path.join(TB, "stats.json"), "w") as f:
    json.dump({"daily_returns": [0.0]}, f)


def flags(**kw):
    with open(os.path.join(SDIR, "flags.json"), "w") as f:
        json.dump(kw, f)


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def stats():
    return read(os.path.join(SDIR, "stats.json"))


def perf_doc():
    return read(os.path.join(SDIR, cl.PERF_REFRESH_FILE))


def child_env():
    return read(os.path.join(SDIR, "env.json")) or {}


def wait_idle(timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        with cl._PERF_PENDING_LOCK:
            if not cl._PERF_PENDING:
                return True
        time.sleep(0.2)
    return False


def send(names):
    return cl.dispatch({"cmd": "stats_refresh", "args": {"names": names}})


def refused(args):
    try:
        cl.dispatch({"cmd": "stats_refresh", "args": args})
    except ValueError as e:
        return str(e).split(":")[0]
    return None


def perf_of(name):
    for s in rep.scan():
        if s["name"] == name:
            return s.get("perf")
    return "absent"


# ── 1. args ─────────────────────────────────────────────────────────────────
check("stats_refresh" in cl.HANDLERS, "the command has a handler")
for a in ({"name": NAME}, {"names": NAME}, {"names": []}, {"names": ["a" * 129]}, {"names": ["bad.name"]},
          {"names": [NAME, NAME]}, {"names": [f"s{i}" for i in range(51)]}, {"names": [NAME], "extra": 1}):
    check(refused(a) == "BAD_ARGS", f"bad args refused: {str(a)[:60]}")

# ── 2. per-name skips ────────────────────────────────────────────────────────
r = send(["tb", NAME])
check(r == {"started": [], "skipped": {"tb": "NOT_RUNNABLE", NAME: "NO_STATS"}},
      f"Type B → NOT_RUNNABLE, never backtested → NO_STATS, nothing started ({r})")
check(not os.path.exists(os.path.join(TB, "ran")), "the Type B script was not executed")

# ── 3. happy path ───────────────────────────────────────────────────────────
flags(n=300)
r = subprocess.run([sys.executable, os.path.join("strategies", NAME, "strategy.py")], cwd=WS,
                   env=dict(os.environ, BLAVE_MODE="backtest", PYTHONPATH=WS), capture_output=True, text=True, timeout=180)
st0 = stats()
check(r.returncode == 0 and st0 is not None and os.path.exists(os.path.join(SDIR, "versions", "v1.json")),
      f"backtest wrote stats.json + v1 (rc {r.returncode}: {(r.stderr or '')[-200:]})")
with open(os.path.join(SDIR, "versions", "index.json"), "rb") as f:
    idx0 = f.read()
mtime0 = os.stat(os.path.join(SDIR, "stats.json")).st_mtime
p = perf_of(NAME)
check(p == {"at": int(mtime0)}, f"report: perf.at = stats.json mtime, no refresh block while idle ({p})")
time.sleep(1.1)   # mtime resolution
flags(n=360)
del PUSHES[:]
r = send([NAME])
check(r == {"started": [NAME], "skipped": {}}, f"ack says started ({r})")
d = perf_doc()
check(d is not None and d.get("status") == "running" and d.get("pid") == os.getpid(),
      f"perf_refresh.json running right after the ack ({d})")
check(len(PUSHES) == 1, f"one push at ack time so the page reads 更新中 ({len(PUSHES)})")
check(wait_idle(), "the refresh finished")
st1 = stats()
check(st1["end"] > st0["end"] and st1["Generated At"] == st0["Generated At"],
      f"stats.json rewritten on the longer data, Generated At carried ({st0['end']} → {st1['end']})")
with open(os.path.join(SDIR, "versions", "index.json"), "rb") as f:
    check(f.read() == idx0 and not os.path.exists(os.path.join(SDIR, "versions", "v2.json")),
          "no version minted, index untouched")
check(not os.path.exists(os.path.join(SDIR, "state.json")), "no state.json written")
env = child_env()
check(env.get("BLAVE_MODE") == "live" and env.get(cl.STATS_REFRESH_ENV) == "1",
      f"child ran as BLAVE_MODE=live + BLAVE_STATS_REFRESH=1 ({env})")
check(perf_doc() is None and len(PUSHES) == 2, f"record gone and a second push on completion ({len(PUSHES)})")
p = perf_of(NAME)
check(p == {"at": int(os.stat(os.path.join(SDIR, "stats.json")).st_mtime)} and p["at"] > int(mtime0),
      f"report: perf.at advanced, no refresh block ({p})")

# BUSY while one is running; the report shows running meanwhile
flags(n=360, sleep=4)
send([NAME])
r = send([NAME])
check(r == {"started": [], "skipped": {NAME: "BUSY"}}, f"queued again while running → BUSY ({r})")
p = perf_of(NAME)
check(isinstance(p, dict) and p.get("refresh", {}).get("status") == "running",
      f"report: perf.refresh running mid-run ({p})")
check(wait_idle(), "the slow refresh finished")

# ── 4. failure + restart settle ─────────────────────────────────────────────
flags(data=1)
mt = os.stat(os.path.join(SDIR, "stats.json")).st_mtime
send([NAME])
check(wait_idle(), "the failing refresh finished")
d = perf_doc()
check(d is not None and d.get("status") == "failed" and d.get("err") == "DATA",
      f"a data failure → perf_refresh.json failed DATA ({d})")
check(os.stat(os.path.join(SDIR, "stats.json")).st_mtime == mt, "stats.json untouched by the failed run")
p = perf_of(NAME)
check(isinstance(p, dict) and p.get("refresh") == {"status": "failed", "at": d["at"], "err": "DATA"},
      f"report: perf.refresh carries the failure ({p})")
# the manifest marker must move on the record alone (stats.json untouched by a failure), or
# report_cache skips the strategy and the api never hears that the refresh ended
strat = next(s for s in rep.scan() if s["name"] == NAME)
m_failed = rep.strategy_marker(strat)
os.rename(os.path.join(SDIR, cl.PERF_REFRESH_FILE), os.path.join(BASE, "perf.bak"))
m_idle = rep.strategy_marker(strat)
with open(os.path.join(SDIR, cl.PERF_REFRESH_FILE), "w") as f:
    json.dump({"status": "running", "at": int(time.time()), "pid": os.getpid()}, f)
m_running = rep.strategy_marker(strat)
os.replace(os.path.join(BASE, "perf.bak"), os.path.join(SDIR, cl.PERF_REFRESH_FILE))
check(len({m_failed, m_idle, m_running}) == 3,
      "strategy_marker differs across idle / running / failed with the same stats.json (the strategy is re-sent)")
flags(n=360)
send([NAME])
check(wait_idle() and perf_doc() is None, "a later success clears the failed record")
with open(os.path.join(SDIR, cl.PERF_REFRESH_FILE), "w") as f:
    json.dump({"status": "running", "at": 1, "pid": 1}, f)
cl._resume_perf_refresh()
d = perf_doc()
check(d is not None and d.get("status") == "failed" and d.get("err") == "EXIT",
      f"listener start settles a stale running record as failed EXIT ({d})")
os.remove(os.path.join(SDIR, cl.PERF_REFRESH_FILE))

# ── 5. the pre-report sweep ─────────────────────────────────────────────────
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {NAME: 10, "tb": 5}, "exchanges": {}}, f)
MARK = os.path.join(BASE, "report-started")
cl._report_runner_cmd = lambda job_id: [sys.executable, "-c",
                                        f"open({MARK!r}, 'w').write({job_id!r})"]
cl._bound_venue = lambda: True
old = time.time() - 2 * cl.STATS_REFRESH_MIN_AGE_S
os.utime(os.path.join(SDIR, "stats.json"), (old, old))
os.utime(os.path.join(TB, "stats.json"), (old, old))
os.remove(os.path.join(SDIR, "env.json"))
flags(n=420)
del PUSHES[:]
cl._start_report_job("daily")
check(os.stat(os.path.join(SDIR, "stats.json")).st_mtime > old + 60 and stats()["end"] > st1["end"],
      "sweep refreshed the stale live Type A member before the report")
check(not os.path.exists(os.path.join(TB, "ran")), "sweep never ran the Type B member")
for _ in range(50):
    if os.path.exists(MARK):
        break
    time.sleep(0.1)
check(os.path.exists(MARK) and open(MARK).read() == "daily", "the report job started after the sweep")
check(len(PUSHES) == 1 and perf_doc() is None, f"sweep: one push, record cleared ({len(PUSHES)})")
fresh = os.stat(os.path.join(SDIR, "stats.json")).st_mtime
os.remove(os.path.join(SDIR, "env.json"))
cl._refresh_live_stats("again")
check(os.stat(os.path.join(SDIR, "stats.json")).st_mtime == fresh and not os.path.exists(os.path.join(SDIR, "env.json")),
      "a stats.json younger than an hour is skipped (no subprocess)")
os.utime(os.path.join(SDIR, "stats.json"), (old, old))
cl._bound_venue = lambda: False
cl._refresh_live_stats("unbound")
check(os.stat(os.path.join(SDIR, "stats.json")).st_mtime == old and not os.path.exists(os.path.join(SDIR, "env.json")),
      "no venue bound → the sweep does nothing (same gate as the scheduler)")
src = open(os.path.join(RUNTIME, "command_listener.py"), encoding="utf-8").read()
body = src[src.index("def _fire_due_reports"):src.index("def _start_report_job")]
check("_start_report_job" in body and "_report_runner_cmd" not in body,
      "_fire_due_reports starts a due job through _start_report_job (sweep first), not a direct Popen")
check("report_run_now" in src and "_refresh_live_stats" not in src[src.index("def _cmd_report_run_now"):src.index("def _cmd_report_delete")],
      "立即執行 does not sweep first")

shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
