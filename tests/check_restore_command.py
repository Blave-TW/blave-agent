"""Minimal check for the direct `version_restore` command — the runtime half of restoring a
strategy version in place (.claude/docs/strategy-versions.md §5/§9; lib half:
tests/check_restore_in_place.py). No network; real subprocesses in a temp workspace that
carries a copy of this repo's lib/.

  1. args: exactly {name, n}; name [A-Za-z0-9_-]{1,128}; n an int (not bool) in 1..1e6.
     An old lib (no RESTORE_IN_PLACE line) → UPDATE_REQUIRED before anything runs, and the
     strategies report carries no `inplace`.
  2. The happy path: ack {n, inplace, backed_up, rerun: "started"}; file = v<n>, current = n,
     the unbacktested file saved, an event for agent_turn, the report shows rerun running;
     the quiet re-run then writes stats.json, mints nothing, deletes rerun.json and pushes.
  3. The re-run's end states: DATA / REFUSED / TIMEOUT (killed) → failed + that code; the
     same command again (the page's 再跑一次) backs nothing up and completes; an edit that
     overtakes the re-run → rerun.json removed, not left at running (moot).
  4. A second restore kills the first re-run; a refused restore (LIVE / NO_VERSION) leaves a
     running re-run and the file alone; delete_strategy kills a running re-run and the folder
     stays gone; a listener restart adopts a live re-run and settles a dead one.
  5. The agent hears about it: agent_turn injects one system line on the conversation's next
     turn (name, version, previous version, the backup path) — not in a new conversation,
     not for events older than the conversation's last turn — through both build_prompt
     calls. local_daemon allows the command (signed); the desktop's feature_used whitelist
     has version_restore.

Run: cd blave-agent && .venv/bin/python tests/check_restore_command.py
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="restore-cmd-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.environ.update({"BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE, "BLAVE_AGENT_BASE": BASE,
                   "BLAVE_AGENT_WORKSPACE": WS, "BLAVE_AGENT_STATE": os.path.join(BASE, "state"),
                   "BLAVE_AGENT_DB": os.path.join(BASE, "session.db"),
                   "BLAVE_AGENT_LOCAL": "1",   # the child interpreter is this venv's (it has pandas)
                   "MPLBACKEND": "Agg", "PYTHONPYCACHEPREFIX": os.path.join(BASE, "pycache")})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
sys.path.insert(0, RUNTIME)
sdk = types.ModuleType("claude_agent_sdk")   # agent_turn's SDK is not what this checks


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
import local_daemon as ld  # noqa: E402
import agent_turn  # noqa: E402
import session_store as ss  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1


PUSHES = []
cl._ON_APPLIED = lambda: PUSHES.append(time.time())
NAME = "momo"
SDIR = os.path.join(WS, "strategies", NAME)
SRC = os.path.join(SDIR, "strategy.py")
VDIR = os.path.join(SDIR, "versions")
FLAGS = os.path.join(SDIR, "flags.json")   # read by the strategy: {note: "sleep:N" | "data" | "refuse"}
os.makedirs(SDIR)
TEMPLATE = '''import json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import numpy as np
import pandas as pd
from lib.runner import run

STRATEGY_NAME = "momo"
SYMBOL        = "BTCUSDT"
INTERVAL      = "1h"
START         = "2024-01-01"
FEE           = 0.0005
MCPT          = False
VERSION_NOTE  = "{note}"


def fetch_data(hdrs):
    try:
        how = json.loads(Path(__file__).with_name("flags.json").read_text()).get(VERSION_NOTE, "")
    except (OSError, ValueError):
        how = ""
    Path(__file__).with_name("fetching").write_text(VERSION_NOTE)
    Path(__file__).with_name("envflag").write_text(__import__("os").environ.get("BLAVE_AGENT_LOCAL", "-"))
    if how.startswith("sleep:"):
        time.sleep(float(how[6:]))
    if how == "data":
        from lib.data import DataAccessError
        raise DataAccessError("ERR007 test: no data access")
    if how == "refuse":
        raise SystemExit("\\u274c Backtest refused \\u2014 test gate")
    idx = pd.date_range("2024-01-01", periods=300, freq="h")
    c = pd.Series(100 + np.cumsum(np.sin(np.arange(300) / {period})), index=idx)
    return pd.DataFrame({{"Open": c, "High": c, "Low": c, "Close": c, "Volume": 1.0}}, index=idx)


def compute(df):
    return pd.Series(np.where(np.arange(len(df)) % 30 < 15, 1.0, 0.0), index=df.index)


run(locals(), fetch_data, compute)
'''


def code(note, period):
    return TEMPLATE.format(note=note, period=period)


A, B, C = code("a", 5.0), code("b", 7.0), code("c", 9.0)


def flags(**kw):
    with open(FLAGS, "w") as f:
        json.dump(kw, f)


def write(src):
    with open(SRC, "w", encoding="utf-8") as f:
        f.write(src)


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def backtest(src):
    write(src)
    import subprocess
    r = subprocess.run([sys.executable, SRC], cwd=WS, capture_output=True, text=True,
                       env=dict(os.environ, BLAVE_MODE="backtest", BLAVE_QUIET="1"), timeout=180)
    assert r.returncode == 0, r.stderr[-800:]


def index():
    return json.loads(read(os.path.join(VDIR, "index.json")))


def rerun_doc():
    return cl._read_rerun_doc(NAME)


def wait(cond, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.2)
    return False


def restore(n, name=NAME):
    d = cl.dispatch({"cmd": "version_restore", "args": {"name": name, "n": n}})
    assert isinstance(d, cl.Deferred)
    return d.fn()


def refused(n, name=NAME):
    try:
        restore(n, name)
    except ValueError as e:
        return str(e).split(":", 1)[0]
    return None


def pid_alive(pid):
    """Running, not a zombie (a killed child stays a zombie until its watcher reaps it)."""
    import subprocess
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(st) and not st.startswith("Z")


def settled():
    return rerun_doc() is None or rerun_doc().get("status") != "running"


with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {}, "exchanges": {}}, f)
flags()
backtest(A)
backtest(B)
check(index()["counter"] == 2 and index()["current"] == 2, "setup: v1, v2 minted in the temp workspace")

# ── 1. args + capability ─────────────────────────────────────────────────────
bad = [{}, {"name": NAME}, {"n": 1}, {"name": NAME, "n": 1, "x": 1}, {"name": "x" * 129, "n": 1},
       {"name": "a.b", "n": 1}, {"name": "../x", "n": 1}, {"name": NAME, "n": 0},
       {"name": NAME, "n": 1000001}, {"name": NAME, "n": True}, {"name": NAME, "n": "1"},
       {"name": NAME, "n": 1.0}, {"name": 5, "n": 1}]
codes = set()
for a in bad:
    try:
        cl.dispatch({"cmd": "version_restore", "args": a})
        codes.add("accepted")
    except ValueError as e:
        codes.add(str(e).split(":", 1)[0])
check(codes == {"BAD_ARGS"}, f"bad args → BAD_ARGS before anything runs (got {codes})")
check(cl._VERSION_RESTORE_NAME_RE.pattern == "[A-Za-z0-9_-]{1,128}" and cl._VERSION_RESTORE_MAX_N == 1000000,
      "name rule and version ceiling = the api's version endpoints")

lib_py = os.path.join(WS, "lib", "strategy.py")
real_lib = read(lib_py)
with open(lib_py, "w", encoding="utf-8") as f:
    f.write(real_lib.replace("RESTORE_IN_PLACE = 1", "# (older lib)"))
os.utime(lib_py, (time.time() + 5, time.time() + 5))
write(A)
try:
    cl.dispatch({"cmd": "version_restore", "args": {"name": NAME, "n": 1}})
    check(False, "old lib → UPDATE_REQUIRED")
except ValueError as e:
    check(str(e).startswith("UPDATE_REQUIRED:") and read(SRC) == A and index()["current"] == 2,
          "old lib → UPDATE_REQUIRED, synchronously, nothing touched")
check("inplace" not in rep._read_versions(NAME), "old lib → the report carries no `inplace`")
with open(lib_py, "w", encoding="utf-8") as f:
    f.write(real_lib)
os.utime(lib_py, (time.time() + 10, time.time() + 10))
check(rep._read_versions(NAME).get("inplace") is True, "current lib → the report says inplace: true")

# ── 2. happy path ────────────────────────────────────────────────────────────
X = code("x", 11.0)
write(X)
del PUSHES[:]
res = restore(1)
check(res == {"n": 1, "inplace": True, "backed_up": True, "rerun": "started"}, f"ack result {res}")
check(read(SRC) == A and index()["current"] == 1 and index()["counter"] == 2,
      "…file = v1, current = 1, no new number")
check(read(os.path.join(VDIR, "pre-restore.py")) == X, "…the unbacktested file saved to pre-restore.py")
check(not os.path.exists(os.path.join(SDIR, "stats.json")), "…stats.json moved aside at once")
ev = [json.loads(x) for x in read(cl.VERSION_EVENTS_PATH).splitlines()]
check(ev[-1]["name"] == NAME and ev[-1]["n"] == 1 and ev[-1]["prev"] == 2 and ev[-1]["backed_up"] is True,
      f"…an event for agent_turn {ev[-1]}")
rr = rep._read_versions(NAME).get("rerun")
check(rr and rr["n"] == 1 and rr["status"] == "running" and set(rr) == {"n", "status", "at"},
      f"…the report shows the re-run running, no pid / script (got {rr})")
check(len(PUSHES) >= 1, "…and pushes the report right after the restore")
check(wait(lambda: rerun_doc() is None), "the quiet re-run finishes and the runner deletes rerun.json")
check(read(os.path.join(SDIR, "envflag")) == "1",
      "desktop re-run carries BLAVE_AGENT_LOCAL=1 (same data path as the agent's own backtest: 台股 from TWSE / TPEx)")
seen_env = []
real_popen = cl.subprocess.Popen


class _NoPopen:
    def __init__(self, argv, **kw):
        seen_env.append(kw.get("env") or {})
        self.pid = 999999

    def poll(self):
        return 0

    def wait(self, timeout=None):
        return 0


cl.subprocess.Popen = _NoPopen
os.environ["BLAVE_AGENT_LOCAL"] = ""
try:
    real_watch = cl._watch_rerun
    cl._watch_rerun = lambda *a: None
    cl._start_rerun(NAME, 1, SRC)
finally:
    cl._watch_rerun = real_watch
    cl.subprocess.Popen = real_popen
    os.environ["BLAVE_AGENT_LOCAL"] = "1"
    cl._RERUN_PROCS.pop(NAME, None)
    os.remove(os.path.join(VDIR, "rerun.json"))
check(seen_env and "BLAVE_AGENT_LOCAL" not in seen_env[0] and seen_env[0].get("BLAVE_MODE") == "backtest",
      "cloud re-run: no BLAVE_AGENT_LOCAL (the cloud has no key-free path); live ticks untouched")
check(cl._strategy_subprocess_env().get("BLAVE_AGENT_LOCAL") == "1",
      "the desktop live tick env carries BLAVE_AGENT_LOCAL=1 as well (same key-free data path as the backtest that approved it)")
check(os.path.exists(os.path.join(SDIR, "stats.json")) and index()["counter"] == 2 and index()["current"] == 1,
      "…stats.json back, nothing minted, current still 1")
check(wait(lambda: len(PUSHES) >= 2, 10), "…and the watcher pushes once more at the end")
check("rerun" not in rep._read_versions(NAME), "…the report no longer carries rerun")

# ── 3. end states ────────────────────────────────────────────────────────────
for how, want in (("data", "DATA"), ("refuse", "REFUSED")):
    flags(b=how)
    restore(2)
    check(wait(settled) and rerun_doc() == dict(rerun_doc(), status="failed", err=want)
          and "pid" not in rerun_doc(), f"re-run {how} → failed, err {want}")
    check(rep._read_versions(NAME)["rerun"] == {"n": 2, "status": "failed", "at": rerun_doc()["at"], "err": want},
          f"…the report says failed / {want}")
flags()
res = restore(2)
check(res["backed_up"] is False and read(os.path.join(VDIR, "pre-restore.py")) == X,
      "再跑一次 (same command): nothing backed up, the earlier backup kept")
check(wait(lambda: rerun_doc() is None), "…and this time it completes")

cl.RESTORE_RERUN_TIMEOUT_S = 3
flags(a="sleep:60")
restore(1)
pid = rerun_doc()["pid"]
check(wait(settled, 30) and rerun_doc().get("err") == "TIMEOUT", "a re-run past the budget → killed, TIMEOUT")
check(wait(lambda: not pid_alive(pid), 10), "…and its process is gone")
cl.RESTORE_RERUN_TIMEOUT_S = 15 * 60

flags(a="sleep:4")
FETCHING = os.path.join(SDIR, "fetching")
if os.path.exists(FETCHING):
    os.remove(FETCHING)
restore(1)
wait(lambda: os.path.exists(FETCHING), 30)
write(C)   # the agent edits the file while the re-run sleeps
check(wait(lambda: rerun_doc() is None, 60), "an edit overtakes the re-run → rerun.json removed (not stuck at running)")
check(not os.path.exists(os.path.join(SDIR, "stats.json")) and index()["current"] == 1
      and index()["counter"] == 2, "…the discarded run wrote no stats.json and minted nothing")
write(A)
flags()
restore(1)
env_seen = cl._strategy_subprocess_env("backtest", BLAVE_QUIET="1")
check(env_seen.get("BLAVE_MODE") == "backtest" and env_seen.get("BLAVE_QUIET") == "1",
      "the re-run env is a quiet backtest (explicit, so the Windows denylist cannot strip it)")
check(wait(lambda: rerun_doc() is None), "(back to a clean state)")

# ── 4. concurrency, refusals, delete, restart ───────────────────────────────
flags(a="sleep:60", b="sleep:60")
restore(1)
first = rerun_doc()["pid"]
restore(2)
second = rerun_doc()["pid"]
check(first != second and wait(lambda: not pid_alive(first), 10) and rerun_doc()["n"] == 2,
      "a second restore kills the first re-run and records its own")
time.sleep(1.5)
check(rerun_doc() and rerun_doc()["pid"] == second and rerun_doc()["status"] == "running",
      "…the killed run's watcher does not overwrite the new record")
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {NAME: 100}, "exchanges": {}}, f)
before = read(SRC)
check(refused(1) == "LIVE" and read(SRC) == before and rerun_doc()["pid"] == second and pid_alive(second),
      "funded → LIVE; the file and the running re-run left alone")
with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {}, "exchanges": {}}, f)
check(refused(99) == "NO_VERSION" and pid_alive(second), "missing version → NO_VERSION; re-run left alone")

cl._RERUN_PROCS.clear()   # as if the listener restarted under a running re-run
adopted = []
real_adopt = cl._adopt_rerun
cl._adopt_rerun = lambda name, pid: adopted.append((name, pid))
cl._resume_restore_watch()
check(adopted == [(NAME, second)], "listener restart: a live re-run is adopted (identity from its command line)")
cl._adopt_rerun = real_adopt
cl._kill_tree(second)
wait(lambda: not pid_alive(second), 10)
cl._resume_restore_watch()
check(rerun_doc() and rerun_doc()["status"] == "failed" and rerun_doc()["err"] == "EXIT",
      "listener restart: a dead re-run on v2's code is settled as failed")

held = cl._RESTORE_LOCK.acquire()
import threading as _th
got = {}
t0 = time.time()
real_acq = cl._RESTORE_LOCK
class _Busy:
    def acquire(self, timeout=-1):
        return False
    def release(self):
        pass
cl._RESTORE_LOCK = _Busy()
try:
    cl._cmd_delete_strategy({"name": NAME})
    check(False, "delete during a restore → refused, not blocked")
except RuntimeError as e:
    check("try again" in str(e) and os.path.exists(SDIR), "delete while a restore holds the lock → bounded wait, 'try again', nothing deleted")
finally:
    cl._RESTORE_LOCK = real_acq
    real_acq.release()
flags(a="sleep:60")
restore(1)
pid = rerun_doc()["pid"]
out = cl._cmd_delete_strategy({"name": NAME})
check(out.startswith("delete_strategy=") and wait(lambda: not pid_alive(pid), 10),
      "delete_strategy kills the running re-run")
time.sleep(2)
check(not os.path.exists(SDIR), "…and the folder stays gone")

# ── 5. the agent, the daemon, telemetry ──────────────────────────────────────
sid = "web-1-000000000001"
check(agent_turn.version_restore_note(ss.last_turn_at(sid)) is None,
      "a conversation with no turns yet gets no note")
ss.append_turn(sid, "user", "hi")
ss.append_turn(sid, "assistant", "hello")
check(agent_turn.version_restore_note(ss.last_turn_at(sid)) is None, "events older than the last turn → no note")
cl._record_version_event("momo", 3, 7, True)
cl._record_version_event("other_1", 5, None, False)
note = agent_turn.version_restore_note(ss.last_turn_at(sid))
check(note and "「momo」還原到 v3(原本 v7)" in note and "strategies/momo/versions/pre-restore.py" in note
      and "「other_1」還原到 v5" in note and "重讀" in note and note.startswith("[系統訊息,不是使用者說的"),
      f"next turn: one system line naming both, the previous version, the backup path, reread first ({note})")
for i in range(5):
    cl._record_version_event(f"s{i}", 1, None, False)
check(agent_turn.version_restore_note(ss.last_turn_at(sid)).count("還原到") == agent_turn.VERSION_NOTE_MAX_EVENTS,
      "at most three events per note")
with open(cl.VERSION_EVENTS_PATH, "a") as f:
    f.write("not json\n" + json.dumps({"at": time.time(), "name": "../x", "n": 1}) + "\n")
check("../x" not in agent_turn.version_restore_note(ss.last_turn_at(sid)), "malformed / bad-name events skipped")
for i in range(60):
    cl._record_version_event("s", i + 1, None, False)
check(len(read(cl.VERSION_EVENTS_PATH).splitlines()) == cl.VERSION_EVENTS_KEEP, "the event log keeps the last 50")
p = agent_turn.build_prompt("", [], "改一下 momo", version_note=note)
check(p.index(note) < p.index("[使用者這次的訊息]"), "build_prompt carries the note before the user's message")
src = read(os.path.join(RUNTIME, "agent_turn.py"))
check(src.count("version_note=version_note") == 2
      and "version_restore_note(ss.last_turn_at(session_id))" in src
      and src.index("version_restore_note(ss.last_turn_at(session_id))") < src.index('ss.append_turn(session_id, "user", message)'),
      "run_turn reads the note before this turn's row is written, and both build_prompt calls pass it")
check("version_restore" in ld.ALLOWED and "version_restore" not in ld.UNSIGNED_OK,
      "local_daemon allows version_restore, signed only")
check(re.search(r'"version_restore"', read(os.path.join(ROOT, "shell", "telemetry.js"))) is not None,
      "the desktop feature_used whitelist has version_restore")

shutil.rmtree(BASE, ignore_errors=True)
print("FAILED" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
