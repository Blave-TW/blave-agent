"""The direct `rename_strategy` command — the runtime half of renaming a strategy (spec
strategy-rename-2026-11-05 §5/§6; lib half: tests/check_strategy_rename.py). No network; real
subprocesses in a temp workspace that carries a copy of this repo's lib/.

  1. args: exactly {name, display_name}; an old lib (no STRATEGY_RENAME line) → UPDATE_REQUIRED
     and the strategies report leaves `renamable` out; the current lib → `renamable: true`.
  2. happy path: ack {display_name, changed}; the file's DISPLAY_NAME changed, nothing else;
     pushes; lib's refusals come back as their codes (BAD_NAME / DUPLICATE / NOT_FOUND /
     JOB_RUNNING); a chat turn on the machine → TURN_RUNNING, a scheduled report's does not.
  3. after the rename, 更新績效's plan still sees a stored version (not CODE_CHANGED), and a
     restore keeps the name and its quiet re-run finishes without minting — also over versions
     minted before the rule (raw hashes, raw blob code_hash).
  4. the runtime's hash = lib's (tests/fixtures/code_hash_name.json); local_daemon allows the
     command.

Run: cd blave-agent && .venv/bin/python tests/check_rename_command.py
"""
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
BASE = tempfile.mkdtemp(prefix="rename-cmd-")
WS = os.path.join(BASE, "workspace")
os.makedirs(os.path.join(WS, "manager"))
os.makedirs(os.path.join(WS, "state"))
shutil.copytree(os.path.join(ROOT, "lib"), os.path.join(WS, "lib"),
                ignore=shutil.ignore_patterns("__pycache__"))
os.environ.update({"BLAVE_AGENT_HOME": BASE, "BLAVECLAW_HOME": BASE, "BLAVE_AGENT_BASE": BASE,
                   "BLAVE_AGENT_WORKSPACE": WS, "BLAVE_AGENT_STATE": os.path.join(BASE, "state"),
                   "BLAVE_AGENT_DB": os.path.join(BASE, "session.db"),
                   "BLAVE_AGENT_LOCAL": "1",
                   "MPLBACKEND": "Agg", "PYTHONPYCACHEPREFIX": os.path.join(BASE, "pycache")})
os.environ.pop("BLAVE_PROXY_TOKEN", None)
sys.path.insert(0, RUNTIME)
sys.modules.setdefault("claude_agent_sdk", types.ModuleType("claude_agent_sdk"))
import command_listener as cl  # noqa: E402
import strategy_reporter as rep  # noqa: E402
import local_daemon as ld  # noqa: E402
import turn_slots  # noqa: E402

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
os.makedirs(SDIR)
TEMPLATE = '''import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import numpy as np
import pandas as pd
from lib.runner import run

STRATEGY_NAME = "momo"
DISPLAY_NAME  = "{display}"  # shown in the sidebar
SYMBOL        = "BTCUSDT"
INTERVAL      = "1h"
START         = "2024-01-01"
FEE           = 0.0005
MCPT          = False
VERSION_NOTE  = "{note}"


def fetch_data(hdrs):
    idx = pd.date_range("2024-01-01", periods=300, freq="h")
    c = pd.Series(100 + np.cumsum(np.sin(np.arange(300) / {period})), index=idx)
    return pd.DataFrame({{"Open": c, "High": c, "Low": c, "Close": c, "Volume": 1.0}}, index=idx)


def compute(df):
    return pd.Series(np.where(np.arange(len(df)) % 30 < 15, 1.0, 0.0), index=df.index)


run(locals(), fetch_data, compute)
'''


def code(display, note, period):
    return TEMPLATE.format(display=display, note=note, period=period)


def write(src, path=SRC):
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def backtest(src=None):
    if src is not None:
        write(src)
    r = subprocess.run([sys.executable, SRC], cwd=WS, capture_output=True, text=True,
                       env=dict(os.environ, BLAVE_MODE="backtest", BLAVE_QUIET="1"), timeout=180)
    assert r.returncode == 0, r.stderr[-800:]


def index():
    return json.loads(read(os.path.join(VDIR, "index.json")))


def rename(value, name=NAME):
    d = cl.dispatch({"cmd": "rename_strategy", "args": {"name": name, "display_name": value}})
    assert isinstance(d, cl.Deferred)
    return d.fn()


def refused(fn):
    try:
        fn()
    except ValueError as e:
        return str(e).split(":", 1)[0]
    return None


def wait(cond, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.2)
    return False


def displayed():
    return rep.strategy_consts(read(SRC)).get("DISPLAY_NAME")


with open(os.path.join(WS, "manager", "portfolio_config.json"), "w") as f:
    json.dump({"amounts": {}, "exchanges": {}}, f)
backtest(code("均線 A", "a", 5.0))
backtest(code("均線 A", "b", 7.0))
check(index()["counter"] == 2 and index()["current"] == 2, "setup: v1, v2 minted in the temp workspace")

# ── 1. args + capability ─────────────────────────────────────────────────────
codes = set()
for a in ({}, {"name": NAME}, {"display_name": "x"}, {"name": NAME, "display_name": "x", "n": 1},
          {"name": "a.b", "display_name": "x"}, {"name": "x" * 129, "display_name": "x"},
          {"name": 5, "display_name": "x"}):
    codes.add(refused(lambda: cl.dispatch({"cmd": "rename_strategy", "args": a})))
check(codes == {"BAD_ARGS"}, f"bad args → BAD_ARGS before anything runs (got {codes})")
check(refused(lambda: cl.dispatch({"cmd": "rename_strategy", "args": {"name": NAME, "display_name": 5}}))
      == "BAD_NAME", "a non-string display_name → BAD_NAME")

lib_py = os.path.join(WS, "lib", "strategy.py")
real_lib = read(lib_py)
write(real_lib.replace("STRATEGY_RENAME = 1", "# (older lib)"), lib_py)
os.utime(lib_py, (time.time() + 5, time.time() + 5))
before = read(SRC)
check(refused(lambda: rename("新")) == "UPDATE_REQUIRED" and read(SRC) == before,
      "old lib → UPDATE_REQUIRED, synchronously, file untouched")
check(not any(s.get("renamable") for s in rep.scan()), "old lib → the report carries no `renamable`")
write(real_lib, lib_py)
os.utime(lib_py, (time.time() + 10, time.time() + 10))
check([s.get("renamable") for s in rep.scan() if s["name"] == NAME] == [True],
      "current lib → the report says renamable: true")

# ── 2. happy path, refusals ──────────────────────────────────────────────────
del PUSHES[:]
res = rename("  趨勢 B ")
check(res == {"display_name": "趨勢 B", "changed": True}, f"ack {res}")
check(displayed() == "趨勢 B" and read(SRC) == before.replace('"均線 A"', '"趨勢 B"'),
      "…only the DISPLAY_NAME string changed (the comment stays)")
check(len(PUSHES) == 1, "…and the strategies report is pushed once")
check(rename("趨勢 B") == {"display_name": "趨勢 B", "changed": False} and len(PUSHES) == 1,
      "the same name again: changed false, no push")
os.makedirs(os.path.join(WS, "strategies", "other"))
write('STRATEGY_NAME = "other"\nDISPLAY_NAME = "別支"\n', os.path.join(WS, "strategies", "other", "strategy.py"))
for v, want in (("別支", "DUPLICATE"), ("a;b", "BAD_NAME"), ("x" * 61, "BAD_NAME"), ("[x]", "BAD_NAME")):
    check(refused(lambda: rename(v)) == want, f"{v[:10]!r} → {want}")
check(refused(lambda: rename("x", name="ghost")) == "NOT_FOUND", "no such strategy → NOT_FOUND")
lk = os.open(os.path.join(SDIR, ".backtest.lock"), os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(lk, fcntl.LOCK_EX)
check(refused(lambda: rename("跑")) == "JOB_RUNNING", "a backtest holds the runner's lock → JOB_RUNNING")
os.close(lk)
os.makedirs(turn_slots.SLOTS_DIR, exist_ok=True)
slot = os.path.join(turn_slots.SLOTS_DIR, "slot-0")
write(json.dumps({"pid": 1, "surface": "web"}), slot)
check(refused(lambda: cl.dispatch({"cmd": "rename_strategy", "args": {"name": NAME, "display_name": "x"}}))
      == "TURN_RUNNING", "a chat turn running on the machine → TURN_RUNNING")
write(json.dumps({"pid": 1, "surface": "report"}), slot)
check(rename("報告中") ["changed"] is True, "a scheduled report's turn does not block it")
os.remove(slot)
check(displayed() == "報告中" and index()["counter"] == 2, "no version minted by any of it")

# ── 3. versions after a rename ───────────────────────────────────────────────
check(cl._refresh_plan(NAME)[1] is None, "更新績效's plan: the renamed file is still a stored version")


def restore_and_settle(n):
    d = cl.dispatch({"cmd": "version_restore", "args": {"name": NAME, "n": n}})
    res = d.fn()
    done = wait(lambda: (cl._read_rerun_doc(NAME) is None or cl._read_rerun_doc(NAME).get("status") != "running")
                and (cl._RERUN_PROCS.get(NAME) is None or cl._RERUN_PROCS[NAME].poll() is not None))
    return res, done, cl._read_rerun_doc(NAME)


for era in ("new", "legacy"):
    if era == "legacy":   # what a machine upgraded from the raw-bytes era holds
        idx = index()
        for i in idx["items"]:
            bp = os.path.join(VDIR, f"v{i['n']}.json")
            blob = json.loads(read(bp))
            raw = hashlib.sha256(blob["code"].encode("utf-8")).hexdigest()[:16]
            i["code_hash"] = blob["code_hash"] = raw
            write(json.dumps(blob), bp)
        write(json.dumps(idx), os.path.join(VDIR, "index.json"))
        rename(f"改名 {era}")
    res, done, doc = restore_and_settle(1)
    check(res.get("inplace") is True and displayed() == ("報告中" if era == "new" else f"改名 {era}"),
          f"[{era}] restore(1) in place, keeping the current name (shows {displayed()!r})")
    check(done and doc is None and os.path.exists(os.path.join(SDIR, "stats.json")),
          f"[{era}] …its quiet re-run finished, not superseded (rerun.json {doc})")
    check(index()["counter"] == 2 and index()["current"] == 1, f"[{era}] …and minted nothing ({index()})")
    restore_and_settle(2)

# ── 4. same hash as lib; daemon ──────────────────────────────────────────────
FIX = json.loads(read(os.path.join(ROOT, "tests", "fixtures", "code_hash_name.json")))
check(all(rep.code_hash(c["src"].encode()) == hashlib.sha256(c["norm"].encode()).hexdigest()[:16]
          for c in FIX["cases"]), "runtime code_hash follows tests/fixtures/code_hash_name.json")
check("rename_strategy" in ld.ALLOWED, "local_daemon allows rename_strategy")

print(f"\n{'FAIL' if fails else 'OK'}: {fails} failure(s)")
sys.exit(1 if fails else 0)
