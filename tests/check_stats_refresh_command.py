"""Minimal check for the `stats_refresh` command and the pre-report performance sweep — the
runtime half of 0.1.21 資源優化案 A (lib half: tests/check_live_tick_lean.py; spec
.claude/output/backend/live-tick-cpu-spec-2026-10-10.md §2–3). No network; real subprocesses in
a temp workspace carrying a copy of this repo's lib/.

  1. args: {names: [1..50 names]}, each [A-Za-z0-9_-]{1,128}, no duplicates; optional
     exec_test, only true and only with one name (spec lag-test-tab-2026-10-26 §5-2).
  1b. BLAVE_EXEC_TEST: "0" on every strategy subprocess (_strategy_subprocess_env, every branch),
     "1" only for an exec_test run (live and quiet-backtest paths); the 更新績效 run, BUSY with
     exec_test and the sweep stay "0"; the reporter tells the api can_exec_test.
  2. per name: a Type B strategy → NOT_RUNNABLE; no stats.json → NO_STATS; queued twice → BUSY.
  3. the happy path, deployed (a key of portfolio_config.json's amounts): ack {started, skipped}
     at once, perf_refresh.json `running` + a push; the run is BLAVE_MODE=live +
     BLAVE_STATS_REFRESH=1; stats.json rewritten with Generated At and the version index
     untouched, no state.json, record gone, another push; the strategies report carries perf.at
     (= stats.json mtime) and perf.refresh only while running / failed.
  3b. not deployed (0.1.22, Wei 10-12: every Type A/C with a stats.json has the button): the run
     is a quiet backtest (BLAVE_MODE=backtest BLAVE_QUIET=1, BLAVE_EXPECT_CODE_HASH = the stored
     version the file equals; the restore re-run's 15-min budget), Generated At restamped, same
     code → nothing minted; a file that equals none of its stored versions (edited since) →
     CODE_CHANGED and nothing runs; never versioned → let through, mints v1; a deployed strategy
     is not gated (canon §6: drift is a flag, not a refusal) and keeps the 600-s live refresh.
  3c. audit-stats-refresh-all: a run that exited 0 without touching stats.json (the runner
     discarded it: the file changed under it) → failed SUPERSEDED on both paths; the sweep skips
     while a button refresh holds the lock and writes no failed record; _mark_perf writes nothing
     for a deleted strategy; INDEX_BROKEN (unreadable index / entry without code_hash) is not
     CODE_CHANGED; an unreadable portfolio_config.json → the whole batch CONFIG_UNREADABLE, a
     missing one = nobody deployed; the runner's "already running" tail classifies as BUSY.
  4. a failed run → perf.refresh {status: failed, err: DATA}; a DataAccessError also writes `why`
     (the child's BLAVE_DATA_ACCESS_WHY, else unknown) for the desktop; a listener restart settles a stale
     `running` record as failed EXIT.
  5. the pre-report sweep (_start_report_job): refreshes stale deployed Type A/C members in front
     of the report, skips Type B and undeployed strategies, skips a stats.json younger than an
     hour, does nothing unbound; _fire_due_reports goes through it.

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
from pathlib import Path

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


def send(names, **extra):
    return cl.dispatch({"cmd": "stats_refresh", "args": dict({"names": names}, **extra)})


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
for a in ({"names": [NAME, "tb"], "exec_test": True}, {"names": [NAME], "exec_test": False},
          {"names": [NAME], "exec_test": "true"}, {"names": [NAME], "exec_test": 1},
          {"names": [NAME], "exec_test": None}, {"exec_test": True}, {"names": [NAME], "exec_test": True, "x": 1}):
    check(refused(a) == "BAD_ARGS", f"bad exec_test refused: {str(a)[:60]}")
check(cl._stats_refresh_args({"names": [NAME], "exec_test": True}) == ([NAME], True)
      and cl._stats_refresh_args({"names": [NAME, "tb"]}) == ([NAME, "tb"], False),
      "exec_test: true with one name is taken; without it, as before")

# ── 1b. BLAVE_EXEC_TEST on every strategy subprocess ────────────────────────
XT = cl.EXEC_TEST_ENV
check(XT == "BLAVE_EXEC_TEST", "the variable lib/runner reads")
_real_local, _real_sys = cl._local_mode, cl.platform.system
for label, local, system in (("local", True, None), ("Linux", False, "Linux"), ("Windows", False, "Windows")):
    cl._local_mode = (lambda v: (lambda: v))(local)
    if system:
        cl.platform.system = (lambda v: (lambda: v))(system)
    e_live, e_bt = cl._strategy_subprocess_env(), cl._strategy_subprocess_env("backtest", BLAVE_QUIET="1")
    e_on = cl._strategy_subprocess_env("live", **{XT: "1"})
    check(e_live.get(XT) == "0" and e_bt.get(XT) == "0" and e_on.get(XT) == "1",
          f"{label}: default \"0\" on live and backtest children, the caller's \"1\" wins ({e_live.get(XT)}, {e_bt.get(XT)}, {e_on.get(XT)})")
    cl._local_mode, cl.platform.system = _real_local, _real_sys
MANIFEST = {}
_real_manifest = rep._send_manifest
rep._send_manifest = lambda payload, *a, **k: MANIFEST.update(payload) or {}
try:
    rep.report_cache([], token="t", record=False)
finally:
    rep._send_manifest = _real_manifest
check(MANIFEST.get("can_exec_test") is True,
      f"the manifest tells the api can_exec_test: True (same runtime as this handler) ({MANIFEST.get('can_exec_test')})")

# ── 2. per-name skips ────────────────────────────────────────────────────────
r = send(["tb", NAME])
check(r == {"started": [], "skipped": {"tb": "NOT_RUNNABLE", NAME: "NO_STATS"}},
      f"Type B → NOT_RUNNABLE, never backtested → NO_STATS, nothing started ({r})")
check(not os.path.exists(os.path.join(TB, "ran")), "the Type B script was not executed")

# ── 3. happy path (deployed) ────────────────────────────────────────────────
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {NAME: 10}, "exchanges": {}}, f)
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
check(env.get(XT) == "0", f"更新績效 (no exec_test) → BLAVE_EXEC_TEST=0 ({env.get(XT)})")
check(perf_doc() is None and len(PUSHES) == 2, f"record gone and a second push on completion ({len(PUSHES)})")
p = perf_of(NAME)
check(p == {"at": int(os.stat(os.path.join(SDIR, "stats.json")).st_mtime)} and p["at"] > int(mtime0),
      f"report: perf.at advanced, no refresh block ({p})")
time.sleep(1.1)
os.remove(os.path.join(SDIR, "env.json"))
r = send([NAME], exec_test=True)
check(r == {"started": [NAME], "skipped": {}} and wait_idle(), f"exec_test: ack started, finished ({r})")
env = child_env()
check(env.get("BLAVE_MODE") == "live" and env.get(cl.STATS_REFRESH_ENV) == "1" and env.get(XT) == "1",
      f"exec_test on the live path → BLAVE_EXEC_TEST=1, still the live refresh ({env})")

# BUSY while one is running; the report shows running meanwhile
flags(n=360, sleep=4)
send([NAME])
r = send([NAME])
check(r == {"started": [], "skipped": {NAME: "BUSY"}}, f"queued again while running → BUSY ({r})")
r = send([NAME], exec_test=True)
check(r == {"started": [], "skipped": {NAME: "BUSY"}}, f"exec_test while running → BUSY, not merged ({r})")
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
check(d.get("why") == "unknown", f"DataAccessError with no shell flag → why unknown ({d})")
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
with open(os.path.join(WS, "state", "data_access.json"), "w") as f:
    json.dump({"BLAVE_DATA_ACCESS": "0", "BLAVE_DATA_ACCESS_WHY": "signed_out"}, f)
send([NAME])
check(wait_idle(), "the signed-out refresh finished")
d_so = perf_doc()
os.remove(os.path.join(WS, "state", "data_access.json"))
check(d_so and d_so.get("err") == "DATA" and d_so.get("why") == "signed_out",
      f"DataAccessError under the shell's signed_out flag → why signed_out ({d_so})")
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

# ── 3b. not deployed: a quiet backtest; off every stored version → CODE_CHANGED ──────────
COLD = "cold"
CDIR = os.path.join(WS, "strategies", COLD)
os.makedirs(CDIR)
with open(os.path.join(CDIR, "strategy.py"), "w", encoding="utf-8") as f:
    f.write(TEMPLATE.format(name=COLD))


def cold(fn):
    return os.path.join(CDIR, fn)


with open(cold("flags.json"), "w") as f:
    json.dump({"n": 300}, f)
r = subprocess.run([sys.executable, os.path.join("strategies", COLD, "strategy.py")], cwd=WS,
                   env=dict(os.environ, BLAVE_MODE="backtest", PYTHONPATH=WS), capture_output=True, text=True, timeout=180)
c0 = read(cold("stats.json"))
check(r.returncode == 0 and c0 is not None and os.path.exists(cold(os.path.join("versions", "v1.json"))),
      f"cold: backtest wrote stats.json + v1 (rc {r.returncode}: {(r.stderr or '')[-200:]})")
v1_hash = (read(cold(os.path.join("versions", "v1.json"))) or {}).get("code_hash")
time.sleep(1.1)
with open(cold("flags.json"), "w") as f:
    json.dump({"n": 360}, f)
os.remove(cold("env.json"))
r = send([COLD])
check(r == {"started": [COLD], "skipped": {}}, f"cold (not deployed, file = v1): ack started ({r})")
check(wait_idle(), "the cold refresh finished")
c1, env = read(cold("stats.json")), read(cold("env.json")) or {}
check(env.get("BLAVE_MODE") == "backtest" and env.get("BLAVE_QUIET") == "1" and env.get("BLAVE_EXPECT_CODE_HASH") == v1_hash
      and cl.STATS_REFRESH_ENV not in env,
      f"cold ran as a quiet backtest pinned to v1's code_hash, not the live refresh ({env})")
check(env.get(XT) == "0", f"cold 更新績效 → BLAVE_EXEC_TEST=0 ({env.get(XT)})")
check(c1 is not None and c1["end"] > c0["end"] and c1["Generated At"] > c0["Generated At"],
      f"cold: the backtest re-ran on the longer data, Generated At restamped ({c0['end']} → {c1['end']})")
cidx = read(cold(os.path.join("versions", "index.json"))) or {}
check(cidx.get("current") == 1 and not os.path.exists(cold(os.path.join("versions", "v2.json"))) and read(cold(cl.PERF_REFRESH_FILE)) is None,
      f"cold: same code → nothing minted, current stays 1, record cleared ({cidx.get('current')})")
os.remove(cold("env.json"))
r = send([COLD], exec_test=True)
env = read(cold("env.json")) if wait_idle() else {}
check(r == {"started": [COLD], "skipped": {}} and (env or {}).get("BLAVE_QUIET") == "1" and (env or {}).get(XT) == "1",
      f"cold exec_test → the quiet backtest with BLAVE_EXEC_TEST=1 ({r}, {env})")
with open(cold("strategy.py"), "a", encoding="utf-8") as f:
    f.write("\n# edited after the last backtest\n")
os.remove(cold("env.json"))
r = send([COLD])
check(r == {"started": [], "skipped": {COLD: "CODE_CHANGED"}}, f"cold edited, not backtested → CODE_CHANGED ({r})")
check(not os.path.exists(cold("env.json")) and not os.path.exists(cold(os.path.join("versions", "v2.json"))) and read(cold(cl.PERF_REFRESH_FILE)) is None,
      "CODE_CHANGED: no subprocess, nothing minted, no record")
# never versioned: let through — its first backtest mints v1, a first version is not an edit
shutil.rmtree(cold("versions"))
TIMEOUTS = {}
_orig_refresh_stats = cl._refresh_stats
cl._refresh_stats = lambda name, timeout, *a: TIMEOUTS.__setitem__(name, timeout) or _orig_refresh_stats(name, timeout, *a)
import hashlib
with open(cold("strategy.py"), "rb") as f:
    edited_hash = hashlib.sha256(f.read()).hexdigest()[:16]
r = send([COLD])
check(r == {"started": [COLD], "skipped": {}} and wait_idle(), f"never versioned (no versions/) → started ({r})")
cidx, env = read(cold(os.path.join("versions", "index.json"))) or {}, read(cold("env.json")) or {}
check(cidx.get("current") == 1 and [i.get("code_hash") for i in cidx.get("items") or []] == [edited_hash]
      and env.get("BLAVE_MODE") == "backtest" and env.get("BLAVE_EXPECT_CODE_HASH") == edited_hash,
      f"never versioned: a quiet backtest pinned to the file's own hash, mints v1 of it ({cidx.get('items')})")
check(TIMEOUTS.get(COLD) == cl.RESTORE_RERUN_TIMEOUT_S == 15 * 60, f"the backtest path gets the restore re-run's 15-min budget ({TIMEOUTS})")
with open(cold(os.path.join("versions", "index.json")), "rb") as f:
    cidx_bytes = f.read()
with open(cold(os.path.join("versions", "index.json")), "w") as f:
    f.write("{half")
r = send([COLD])
check(r == {"started": [], "skipped": {COLD: "INDEX_BROKEN"}}, f"index there but unreadable → INDEX_BROKEN, not CODE_CHANGED ({r})")
with open(cold(os.path.join("versions", "index.json")), "wb") as f:
    f.write(cidx_bytes)
# deployed: not gated — the live refresh runs whatever the file holds (its drift is a flag, canon §6)
with open(os.path.join(SDIR, "strategy.py"), "a", encoding="utf-8") as f:
    f.write("\n# edited after the last backtest\n")
os.remove(os.path.join(SDIR, "env.json"))
r = send([NAME])
check(r == {"started": [NAME], "skipped": {}} and wait_idle() and child_env().get("BLAVE_MODE") == "live",
      f"deployed + edited: still the live refresh, no CODE_CHANGED ({r})")
check(TIMEOUTS.get(NAME) == cl.STATS_REFRESH_TIMEOUT_S == 1200, f"the live path keeps the strategy run's 1200-s budget ({TIMEOUTS})")
cl._refresh_stats = _orig_refresh_stats

# ── 3c. audit follow-ups ────────────────────────────────────────────────────
check(cl._RERUN_ERRS == rep.RERUN_ERRS and {"SUPERSEDED", "BUSY"} <= set(cl._RERUN_ERRS),
      "listener and reporter agree on the error codes, SUPERSEDED / BUSY included")
# live path: the file edited mid-run → the runner discards the run (rc 0, stats.json untouched) → SUPERSEDED
flags(n=360, sleep=4)
mt = os.stat(os.path.join(SDIR, "stats.json")).st_mtime_ns
Path(SDIR, "env.json").unlink(missing_ok=True)
send([NAME])
# env.json is written in fetch_data, after run() has read the source it compares against;
# a fixed sleep raced a slow import under load and the edit landed before that read.
t0 = time.time()
while not os.path.exists(os.path.join(SDIR, "env.json")) and time.time() - t0 < 60:
    time.sleep(0.05)
check(os.path.exists(os.path.join(SDIR, "env.json")), "the live refresh reached fetch_data within 60 s")
with open(os.path.join(SDIR, "strategy.py"), "a", encoding="utf-8") as f:
    f.write("# edited mid-run\n")
check(wait_idle(), "the superseded live refresh finished")
d = perf_doc()
check(d is not None and d.get("status") == "failed" and d.get("err") == "SUPERSEDED" and os.stat(os.path.join(SDIR, "stats.json")).st_mtime_ns == mt,
      f"live refresh discarded by the runner → failed SUPERSEDED, stats.json untouched ({d})")
# backtest path: queued behind the lock, edited before it starts → BLAVE_EXPECT_CODE_HASH mismatch → SUPERSEDED, nothing minted
cl._STATS_REFRESH_LOCK.acquire()
r = send([COLD])
check(r == {"started": [COLD], "skipped": {}}, f"cold queued behind a held lock ({r})")
with open(cold("strategy.py"), "a", encoding="utf-8") as f:
    f.write("# late edit\n")
cl._STATS_REFRESH_LOCK.release()
check(wait_idle(), "the superseded cold backtest finished")
d = read(cold(cl.PERF_REFRESH_FILE))
check(d is not None and d.get("err") == "SUPERSEDED" and not os.path.exists(cold(os.path.join("versions", "v2.json"))),
      f"backtest pinned to the ack-time hash, file edited meanwhile → SUPERSEDED, no version minted ({d})")
os.remove(cold(cl.PERF_REFRESH_FILE))
# the sweep while a button refresh holds the machine: skipped, no failed record on any member
old = time.time() - 2 * cl.STATS_REFRESH_MIN_AGE_S
os.utime(os.path.join(SDIR, "stats.json"), (old, old))
Path(SDIR, cl.PERF_REFRESH_FILE).unlink(missing_ok=True)
cl._bound_venue = lambda: True
cl._STATS_REFRESH_LOCK.acquire()
cl._refresh_live_stats("locked")
cl._STATS_REFRESH_LOCK.release()
check(os.stat(os.path.join(SDIR, "stats.json")).st_mtime == old and perf_doc() is None,
      "sweep under a held lock: skipped, stats.json untouched, no failed record")
# a deleted strategy's record is not recreated
cl._mark_perf("ghost", "failed", "EXIT")
check(not os.path.exists(os.path.join(WS, "strategies", "ghost")), "_mark_perf writes nothing for a strategy folder that is gone")
# an index entry without code_hash: can't tell → INDEX_BROKEN (not CODE_CHANGED); a full index with no match → CODE_CHANGED
with open(cold(os.path.join("versions", "index.json")), "w") as f:
    json.dump({"v": 1, "counter": 1, "current": 1, "items": [{"n": 1, "at": 1}]}, f)
r = send([COLD])
check(r == {"started": [], "skipped": {COLD: "INDEX_BROKEN"}}, f"entry without code_hash → INDEX_BROKEN ({r})")
with open(cold(os.path.join("versions", "index.json")), "wb") as f:
    f.write(cidx_bytes)
r = send([COLD])
check(r == {"started": [], "skipped": {COLD: "CODE_CHANGED"}}, f"full index, edited file → CODE_CHANGED ({r})")
# portfolio_config.json there but unreadable → the whole batch CONFIG_UNREADABLE; missing → nobody deployed
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    f.write("{half")
r = send([NAME, COLD, "tb"])
check(r == {"started": [], "skipped": {NAME: "CONFIG_UNREADABLE", COLD: "CONFIG_UNREADABLE", "tb": "CONFIG_UNREADABLE"}} and cl._deployed_names() is None,
      f"unreadable portfolio_config.json → whole batch CONFIG_UNREADABLE, no one downgraded to a backtest ({r})")
os.remove(os.path.join(WS, "manager", "portfolio_config.json"))
check(cl._deployed_names() == set(), "no portfolio_config.json = nobody deployed (the button still works)")
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {NAME: 10}, "exchanges": {}}, f)
check(cl._classify_rerun("❌ A backtest of cold is already running (PID 7, started 09:00) — wait for it") == "BUSY",
      "the runner's lock-wait exit classifies as BUSY, not EXIT")

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
os.utime(cold("stats.json"), (old, old))
os.remove(os.path.join(SDIR, "env.json"))
flags(n=420)
del PUSHES[:]
cl._start_report_job("daily")
check(os.stat(os.path.join(SDIR, "stats.json")).st_mtime > old + 60 and stats()["end"] > st1["end"],
      "sweep refreshed the stale live Type A member before the report")
check(not os.path.exists(os.path.join(TB, "ran")), "sweep never ran the Type B member")
check(os.stat(cold("stats.json")).st_mtime == old, "sweep left the stale undeployed strategy alone (button only)")
for _ in range(50):
    if os.path.exists(MARK):
        break
    time.sleep(0.1)
check(os.path.exists(MARK) and open(MARK).read() == "daily", "the report job started after the sweep")
check(len(PUSHES) == 1 and perf_doc() is None, f"sweep: one push, record cleared ({len(PUSHES)})")
check(child_env().get(XT) == "0", f"the sweep's live refresh → BLAVE_EXEC_TEST=0 ({child_env().get(XT)})")
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
